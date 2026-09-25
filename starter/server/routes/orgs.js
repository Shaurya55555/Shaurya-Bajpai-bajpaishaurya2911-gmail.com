import { badRequest, forbidden, notFound, selfRoleChange, send } from '../http.js';
import { newId, nowIso, bumpPermVersion } from '../db.js';
import { resolve, assertCan } from '../permissions.js';
import { roleRanks, assertRoleExists, assertCanModify, assertNotLastOwner, endActiveSessions } from '../lifecycle.js';
import { audit } from '../audit.js';

const THEMES = ['cobalt', 'amber', 'moss', 'plum', 'rust', 'teal'];

function loadOrg(db, orgId) {
  const org = db.prepare(`SELECT * FROM organizations WHERE id = ? AND deleted_at IS NULL`).get(orgId);
  if (!org) throw notFound();
  return org;
}

function loadActiveMember(db, orgId, userId) {
  const row = db.prepare(`SELECT * FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'`).get(orgId, userId);
  if (!row) throw notFound();
  return row;
}

export function registerOrgRoutes(router, { db }) {
  router.get('/v1/orgs', (ctx, params, res) => {
    const orgs = db
      .prepare(
        `SELECT m.org_id AS id, o.name AS name, o.theme AS theme, m.role AS role
         FROM memberships m JOIN organizations o ON o.id = m.org_id
         WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL`
      )
      .all(ctx.userId);
    send(res, 200, { orgs });
  });

  router.post('/v1/orgs', (ctx, params, res) => {
    const { name, theme } = ctx.body ?? {};
    if (!name || typeof name !== 'string') throw badRequest('name is required');
    const chosenTheme = THEMES.includes(theme) ? theme : THEMES[Math.floor(Math.random() * THEMES.length)];

    const orgId = newId('org');
    const memId = newId('mem');
    const now = nowIso();

    db.prepare(`INSERT INTO organizations (id, name, theme) VALUES (?, ?, ?)`).run(orgId, name, chosenTheme);
    db.prepare(
      `INSERT INTO memberships (id, org_id, user_id, role, status, perm_version, joined_at) VALUES (?, ?, ?, 'owner', 'active', 1, ?)`
    ).run(memId, orgId, ctx.userId, now);
    audit(db, { orgId, actorId: ctx.userId, action: 'org.create', targetType: 'org', targetId: orgId, result: 'allow' });

    send(res, 201, { id: orgId, name, theme: chosenTheme, role: 'owner' });
  });

  router.patch('/v1/orgs/:org', (ctx, params, res) => {
    const org = loadOrg(db, params.org);
    assertCan(db, ctx, 'org:update');

    const { name, theme, maxSessionMinutes } = ctx.body ?? {};
    const next = {
      name: name ?? org.name,
      theme: THEMES.includes(theme) ? theme : org.theme,
      maxSessionMinutes: Number.isInteger(maxSessionMinutes) && maxSessionMinutes > 0 ? maxSessionMinutes : org.max_session_minutes,
    };
    db.prepare(`UPDATE organizations SET name = ?, theme = ?, max_session_minutes = ? WHERE id = ?`)
      .run(next.name, next.theme, next.maxSessionMinutes, org.id);
    audit(db, { orgId: org.id, actorId: ctx.userId, action: 'org.update', targetType: 'org', targetId: org.id, result: 'allow' });

    send(res, 200, { id: org.id, ...next });
  });

  router.delete('/v1/orgs/:org', (ctx, params, res) => {
    const org = loadOrg(db, params.org);
    assertCan(db, ctx, 'org:delete');

    db.prepare(`UPDATE organizations SET deleted_at = ? WHERE id = ?`).run(nowIso(), org.id);
    audit(db, { orgId: org.id, actorId: ctx.userId, action: 'org.delete', targetType: 'org', targetId: org.id, result: 'allow' });

    send(res, 200, { id: org.id });
  });

  router.get('/v1/orgs/:org/members', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'user:read');

    const members = db
      .prepare(
        `SELECT m.user_id AS userId, u.email AS email, u.name AS name, m.role AS role, m.status AS status, m.joined_at AS joinedAt
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = ? AND m.status != 'removed'
         ORDER BY m.joined_at ASC`
      )
      .all(params.org);

    send(res, 200, { members });
  });

  router.patch('/v1/orgs/:org/members/:userId', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'user:role:update');

    if (params.userId === ctx.userId) throw selfRoleChange();

    const target = loadActiveMember(db, params.org, params.userId);
    const { role } = ctx.body ?? {};
    if (!role) throw badRequest('role is required');
    assertRoleExists(db, role);
    assertCanModify(db, ctx.role, target.role);

    if (role === 'owner' && ctx.role !== 'owner') {
      throw forbidden('only an owner may confer the owner role', 'insufficient_rank');
    }
    if (target.role === 'owner' && role !== 'owner') {
      assertNotLastOwner(db, params.org, params.userId);
    }

    db.prepare(`UPDATE memberships SET role = ?, perm_version = perm_version + 1 WHERE org_id = ? AND user_id = ?`)
      .run(role, params.org, params.userId);
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'member.role_update', targetType: 'user', targetId: params.userId, result: 'allow' });

    send(res, 200, { userId: params.userId, role });
  });

  router.post('/v1/orgs/:org/members/:userId/suspend', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'user:remove');

    const target = loadActiveMember(db, params.org, params.userId);
    assertCanModify(db, ctx.role, target.role);

    db.prepare(`UPDATE memberships SET status = 'suspended', perm_version = perm_version + 1 WHERE org_id = ? AND user_id = ?`)
      .run(params.org, params.userId);
    endActiveSessions(db, { orgId: params.org, userId: params.userId, reason: 'user_suspended' });
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'member.suspend', targetType: 'user', targetId: params.userId, result: 'allow' });

    send(res, 200, { userId: params.userId, status: 'suspended' });
  });

  router.delete('/v1/orgs/:org/members/:userId/suspend', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'user:remove');

    const target = db.prepare(`SELECT * FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'suspended'`).get(params.org, params.userId);
    if (!target) throw notFound();
    assertCanModify(db, ctx.role, target.role);

    db.prepare(`UPDATE memberships SET status = 'active', perm_version = perm_version + 1 WHERE org_id = ? AND user_id = ?`)
      .run(params.org, params.userId);
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'member.reinstate', targetType: 'user', targetId: params.userId, result: 'allow' });

    send(res, 200, { userId: params.userId, status: 'active' });
  });

  // Registered before the generic /:userId route below so 'me' wins the match.
  router.delete('/v1/orgs/:org/members/me', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertNotLastOwner(db, params.org, ctx.userId);

    db.prepare(`UPDATE memberships SET status = 'removed', perm_version = perm_version + 1 WHERE org_id = ? AND user_id = ?`)
      .run(params.org, ctx.userId);
    endActiveSessions(db, { orgId: params.org, userId: ctx.userId, reason: 'membership_removed' });
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'member.leave', targetType: 'user', targetId: ctx.userId, result: 'allow' });

    send(res, 200, { userId: ctx.userId, status: 'removed' });
  });

  router.delete('/v1/orgs/:org/members/:userId', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'user:remove');

    const target = loadActiveMember(db, params.org, params.userId);
    assertCanModify(db, ctx.role, target.role);
    assertNotLastOwner(db, params.org, params.userId);

    db.prepare(`UPDATE memberships SET status = 'removed', perm_version = perm_version + 1 WHERE org_id = ? AND user_id = ?`)
      .run(params.org, params.userId);
    endActiveSessions(db, { orgId: params.org, userId: params.userId, reason: 'membership_removed' });
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'member.remove', targetType: 'user', targetId: params.userId, result: 'allow' });

    send(res, 200, { userId: params.userId, status: 'removed' });
  });

  router.get('/v1/orgs/:org/users/:userId/effective', (ctx, params, res) => {
    loadOrg(db, params.org);
    if (params.userId !== ctx.userId) assertCan(db, ctx, 'user:read');

    const { role, permissions } = resolve(db, { userId: params.userId, orgId: params.org });
    send(res, 200, { role, permissions });
  });

  router.get('/v1/orgs/:org/audit', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'audit:read');

    const limitRaw = ctx.query.get('limit');
    const offsetRaw = ctx.query.get('offset');
    const limit = limitRaw === null ? 50 : Number(limitRaw);
    const offset = offsetRaw === null ? 0 : Number(offsetRaw);

    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw badRequest('limit must be an integer between 1 and 500');
    if (!Number.isInteger(offset) || offset < 0) throw badRequest('offset must be a non-negative integer');

    const events = db
      .prepare(`SELECT * FROM audit_events WHERE org_id = ? ORDER BY at DESC LIMIT ? OFFSET ?`)
      .all(params.org, limit, offset);

    send(res, 200, { events });
  });
}
