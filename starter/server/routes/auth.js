import { badRequest, unauthenticated, notFound, send } from '../http.js';
import { newId } from '../db.js';
import {
  issueAccessToken, verifyPassword, hashRefreshToken, newRefreshToken, REFRESH_TTL_SECONDS,
} from '../auth.js';
import { resolve } from '../permissions.js';

const COOKIE_NAME = 'refresh_token';

function parseCookie(req, name) {
  const header = req.headers['cookie'];
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function setRefreshCookie(res, raw) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${raw}; HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age=${REFRESH_TTL_SECONDS}`
  );
}

function issueRefreshToken(db, res, userId, familyId = newId('fam')) {
  const raw = newRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString();
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(newId('rt'), userId, hashRefreshToken(raw), familyId, expiresAt);
  setRefreshCookie(res, raw);
}

// The org a token defaults to when the caller doesn't name one: the membership they've
// held longest. Used identically by login and refresh so there is one rule, not two.
function activeMemberships(db, userId) {
  return db
    .prepare(
      `SELECT m.*, o.name AS orgName, o.theme AS theme
       FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = ? AND m.status = 'active'
       ORDER BY m.joined_at ASC`
    )
    .all(userId);
}

function pickMembership(memberships, orgId) {
  return orgId ? memberships.find((m) => m.org_id === orgId) : memberships[0];
}

export function registerAuthRoutes(router, { db, secret }) {
  router.post('/v1/auth/login', async (ctx, params, res) => {
    const { email, password, orgId } = ctx.body ?? {};
    if (!email || !password) throw badRequest('email and password are required');

    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(String(email).toLowerCase());
    // Same message whether the account doesn't exist or the password is wrong — telling
    // them apart is an account-enumeration oracle (UI-INVENTORY.md §4).
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw unauthenticated('invalid email or password');
    }

    const memberships = activeMemberships(db, user.id);
    if (memberships.length === 0) throw unauthenticated('no active organization membership');

    const chosen = pickMembership(memberships, orgId);
    if (!chosen) throw unauthenticated('not an active member of that organization');

    const token = issueAccessToken(
      { userId: user.id, orgId: chosen.org_id, role: chosen.role, permVersion: chosen.perm_version },
      secret
    );
    issueRefreshToken(db, res, user.id);

    send(res, 200, {
      token,
      role: chosen.role,
      orgs: memberships.map((m) => ({ id: m.org_id, name: m.orgName, theme: m.theme })),
    });
  });

  // No orgId in the request: refresh re-derives the default org exactly like login does.
  // The docs don't show a refresh request body, so this is a documented judgment call —
  // see DECISIONS.md.
  router.post('/v1/auth/refresh', async (ctx, params, res) => {
    const raw = parseCookie(ctx.req, COOKIE_NAME);
    if (!raw) throw unauthenticated('missing refresh token');

    const hash = hashRefreshToken(raw);
    const row = db.prepare(`SELECT * FROM refresh_tokens WHERE token_hash = ?`).get(hash);
    if (!row) throw unauthenticated('invalid refresh token');

    if (row.revoked_at) {
      // Reuse of an already-rotated token: revoke the whole lineage.
      db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`)
        .run(new Date().toISOString(), row.family_id);
      throw unauthenticated('refresh token reuse detected');
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) throw unauthenticated('refresh token expired');

    db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);

    const memberships = activeMemberships(db, row.user_id);
    if (memberships.length === 0) throw unauthenticated('no active organization membership');
    const chosen = pickMembership(memberships, ctx.body?.orgId);
    if (!chosen) throw unauthenticated('not an active member of that organization');

    const token = issueAccessToken(
      { userId: row.user_id, orgId: chosen.org_id, role: chosen.role, permVersion: chosen.perm_version },
      secret
    );
    issueRefreshToken(db, res, row.user_id, row.family_id);

    send(res, 200, { token, role: chosen.role });
  });

  router.post('/v1/auth/token', (ctx, params, res) => {
    const { orgId } = ctx.body ?? {};
    if (!orgId) throw badRequest('orgId is required');

    const membership = db
      .prepare(`SELECT * FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'`)
      .get(orgId, ctx.userId);
    if (!membership) throw notFound(); // not a member there: invisible, not forbidden

    const token = issueAccessToken(
      { userId: ctx.userId, orgId, role: membership.role, permVersion: membership.perm_version },
      secret
    );
    send(res, 200, { token, role: membership.role });
  });

  router.get('/v1/auth/me', (ctx, params, res) => {
    const orgs = db
      .prepare(
        `SELECT m.org_id AS id, o.name AS name, o.theme AS theme, m.role AS role
         FROM memberships m JOIN organizations o ON o.id = m.org_id
         WHERE m.user_id = ? AND m.status = 'active'`
      )
      .all(ctx.userId);
    const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId });

    send(res, 200, { userId: ctx.userId, orgId: ctx.orgId, role: ctx.role, orgs, permissions });
  });
}
