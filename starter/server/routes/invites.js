import { badRequest, notFound, conflict, gone, forbidden, send } from '../http.js';
import { newId, nowIso } from '../db.js';
import { newInviteToken, hashInviteToken, hashPassword } from '../auth.js';
import { assertCan } from '../permissions.js';
import { assertRoleExists } from '../lifecycle.js';
import { audit } from '../audit.js';

function loadOrg(db, orgId) {
  const org = db.prepare(`SELECT * FROM organizations WHERE id = ? AND deleted_at IS NULL`).get(orgId);
  if (!org) throw notFound();
  return org;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function registerInviteRoutes(router, { db }) {
  router.post('/v1/orgs/:org/invites', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'user:invite');

    const { email, role } = ctx.body ?? {};
    if (!email || !role) throw badRequest('email and role are required');
    assertRoleExists(db, role);
    if (role === 'owner' && ctx.role !== 'owner') {
      throw forbidden('only an owner may invite an owner', 'insufficient_rank');
    }

    const normEmail = String(email).toLowerCase().trim();

    const existingMember = db
      .prepare(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = ? AND u.email = ? AND m.status = 'active'`
      )
      .get(params.org, normEmail);
    if (existingMember) throw conflict('already an active member of this organization');

    const liveInvite = db
      .prepare(`SELECT 1 FROM invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`)
      .get(params.org, normEmail);
    if (liveInvite) throw conflict('an invite is already pending for this email');

    const raw = newInviteToken();
    const id = newId('inv');
    const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS).toISOString();

    db.prepare(
      `INSERT INTO invites (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, params.org, normEmail, role, hashInviteToken(raw), ctx.userId, expiresAt);
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'invite.create', targetType: 'invite', targetId: id, result: 'allow' });

    // The raw token is returned exactly once. It is never stored or logged anywhere else.
    send(res, 201, { id, email: normEmail, role, expiresAt, inviteToken: raw });
  });

  router.get('/v1/orgs/:org/invites', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'user:invite');

    const invites = db
      .prepare(
        `SELECT id, email, role, expires_at AS expiresAt, accepted_at AS acceptedAt, revoked_at AS revokedAt
         FROM invites WHERE org_id = ? ORDER BY created_at DESC`
      )
      .all(params.org);

    send(res, 200, { invites });
  });

  router.delete('/v1/orgs/:org/invites/:id', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'user:invite');

    const invite = db.prepare(`SELECT * FROM invites WHERE id = ? AND org_id = ?`).get(params.id, params.org);
    if (!invite || invite.revoked_at || invite.accepted_at) throw notFound();

    db.prepare(`UPDATE invites SET revoked_at = ? WHERE id = ?`).run(nowIso(), invite.id);
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'invite.cancel', targetType: 'invite', targetId: invite.id, result: 'allow' });

    send(res, 200, { id: invite.id });
  });

  // Public: no membership yet. Exactly enough to render "invited as <role> to <org>."
  router.get('/v1/invites/:token', (ctx, params, res) => {
    const invite = db
      .prepare(
        `SELECT i.*, o.name AS orgName FROM invites i JOIN organizations o ON o.id = i.org_id
         WHERE i.token_hash = ?`
      )
      .get(hashInviteToken(params.token));
    if (!invite) throw notFound();
    if (invite.revoked_at || invite.accepted_at || new Date(invite.expires_at).getTime() <= Date.now()) throw gone();

    send(res, 200, { orgName: invite.orgName, role: invite.role, email: invite.email, expiresAt: invite.expires_at });
  });

  // Public. Does everything in one go: upsert the user, activate the membership, burn
  // the token. Does NOT create a session (AUTH-DATA-MODEL.md §6).
  router.post('/v1/invites/:token/accept', (ctx, params, res) => {
    const invite = db.prepare(`SELECT * FROM invites WHERE token_hash = ?`).get(hashInviteToken(params.token));
    if (!invite) throw notFound();
    if (invite.accepted_at) throw conflict('invite already accepted');
    if (invite.revoked_at || new Date(invite.expires_at).getTime() <= Date.now()) throw gone();

    const { name, password } = ctx.body ?? {};
    if (!password || String(password).length < 8) throw badRequest('password must be at least 8 characters');

    let user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(invite.email);
    if (!user) {
      if (!name) throw badRequest('name is required');
      const id = newId('usr');
      db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`)
        .run(id, invite.email, name, hashPassword(password));
      user = { id };
    }

    const now = nowIso();
    const existing = db.prepare(`SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?`).get(invite.org_id, user.id);
    if (existing) {
      db.prepare(
        `UPDATE memberships SET role = ?, status = 'active', perm_version = perm_version + 1, joined_at = ?
         WHERE org_id = ? AND user_id = ?`
      ).run(invite.role, now, invite.org_id, user.id);
    } else {
      db.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, status, perm_version, joined_at) VALUES (?, ?, ?, ?, 'active', 1, ?)`
      ).run(newId('mem'), invite.org_id, user.id, invite.role, now);
    }

    db.prepare(`UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?`).run(now, user.id, invite.id);
    audit(db, { orgId: invite.org_id, actorId: user.id, action: 'invite.accept', targetType: 'invite', targetId: invite.id, result: 'allow' });

    send(res, 200, { role: invite.role });
  });
}
