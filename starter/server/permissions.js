// The permission resolution engine. THE ONLY PLACE allow-vs-deny is decided.
//
// Inputs you will need:
//   permissions                 the catalogue (19 rows in db/reference.sql, but read it
//                               from the table, never hardcode it)
//   permission_patterns         the superset grants may name ('device:*', '*', ...)
//   role_permissions            the per-role baseline
//   memberships                 role + status + perm_version
//   grants / grant_permissions  per-user deltas, optionally device-scoped and windowed
//
// NOTE: the database is personalised — a role and a permission exist that this
// exercise's prose never mentions. Everything below reads roles/permissions/patterns
// from the tables; nothing is hardcoded.

import { forbidden } from './http.js';
import { audit } from './audit.js';

// Every refusal that reaches a caller is recorded here too — PERMISSIONS.md invariant 9
// ("records denied attempts as well as successful ones"). This is the one place all
// three assert* functions throw a 403 from, so it is also the one place that needs to
// remember to log the denial; scattering audit(...) calls across ~30 route handlers
// would mean forgetting it in exactly the handler nobody re-reads.
function auditDeny(db, ctx, { action, targetType = null, targetId = null, reasonCode }) {
  audit(db, {
    orgId: ctx.orgId,
    actorId: ctx.userId,
    action,
    targetType,
    targetId,
    result: 'deny',
    reasonCode,
    requestId: ctx.requestId ?? null,
  });
}

export const MODE_PERMISSION = { view: 'device:view', control: 'device:control', terminal: 'device:terminal' };

// Decide one permission from its pre-filtered, pre-windowed candidate grant rows.
// This is the one place D1 (deny wins) and D2 (role baseline, never a rank) are applied,
// shared by both resolve() and resolveDevices() so the two can never drift apart.
function decide(rows, permKey, roleBaseline, role) {
  const deny = rows.find((r) => r.effect === 'deny' && r.permKey === permKey);
  if (deny) return { effect: 'deny', source: `grant:${deny.grantId}`, reason: 'explicit_deny' };

  if (roleBaseline.has(permKey)) return { effect: 'allow', source: `role:${role}`, reason: null };

  const allow = rows.find((r) => r.effect === 'allow' && r.permKey === permKey);
  if (allow) return { effect: 'allow', source: `grant:${allow.grantId}`, reason: null };

  return { effect: 'deny', source: null, reason: 'implicit' };
}

function loadMembership(db, orgId, userId) {
  return db.prepare(`SELECT * FROM memberships WHERE org_id = ? AND user_id = ?`).get(orgId, userId);
}

function loadRoleBaseline(db, role) {
  return new Set(db.prepare(`SELECT permission FROM role_permissions WHERE role = ?`).all(role).map((r) => r.permission));
}

function loadCatalogue(db) {
  return db.prepare(`SELECT key, resource FROM permissions`).all();
}

function emptySet(catalogue, deviceIds, reason, role) {
  const permissions = {};
  for (const p of catalogue) permissions[p.key] = { effect: 'deny', source: null, reason };
  if (!deviceIds) return { role, permissions };
  const byDevice = {};
  for (const id of deviceIds) byDevice[id] = permissions;
  return { role, byDevice };
}

// Membership status -> the reason a fully-empty permission set carries, or null if the
// caller is active and resolution should proceed normally.
function emptyReasonFor(membership) {
  if (!membership) return 'not_a_member';
  if (membership.status === 'suspended') return 'suspended';
  if (membership.status !== 'active') return 'not_a_member'; // invited / removed
  return null;
}

// Resolve one user's full permission set in one org. deviceId === null is the org-level
// view — resolved the same way as a device check, just without a device filter, so a
// grant on any single device is folded into the union rather than needing a second
// algorithm (PERMISSIONS.md §3: "resolved the same way"). A deviceId is the exact
// per-device check.
export function resolve(db, { userId, orgId, deviceId = null, now = new Date() }) {
  const catalogue = loadCatalogue(db);
  const membership = loadMembership(db, orgId, userId);

  const emptyReason = emptyReasonFor(membership);
  if (emptyReason) return emptySet(catalogue, null, emptyReason, membership?.role ?? null);

  const roleBaseline = loadRoleBaseline(db, membership.role);
  const nowIso = now.toISOString();

  const rows = db
    .prepare(
      `SELECT gp.permission AS pattern, g.effect, g.device_id AS deviceId, g.id AS grantId
       FROM grants g
       JOIN grant_permissions gp ON gp.grant_id = g.id
       WHERE g.org_id = ? AND g.user_id = ? AND g.revoked_at IS NULL
         AND (g.starts_at IS NULL OR g.starts_at <= ?)
         AND (g.expires_at IS NULL OR g.expires_at > ?)
         AND (? IS NULL OR g.device_id IS NULL OR g.device_id = ?)`
    )
    .all(orgId, userId, nowIso, nowIso, deviceId, deviceId);

  const permissions = {};
  for (const perm of catalogue) {
    const matching = rows
      .filter((r) => r.pattern === perm.key || r.pattern === `${perm.resource}:*` || r.pattern === '*')
      .map((r) => ({ ...r, permKey: perm.key }));
    permissions[perm.key] = decide(matching, perm.key, roleBaseline, membership.role);
  }

  return { role: membership.role, permissions };
}

// Batched form for list endpoints: one pass over the user's grants, applied to every
// device in one call, instead of one resolve() per row. { role, byDevice: { [id]: permissions } }.
export function resolveDevices(db, { userId, orgId, deviceIds, now = new Date() }) {
  const catalogue = loadCatalogue(db);
  const membership = loadMembership(db, orgId, userId);

  const emptyReason = emptyReasonFor(membership);
  if (emptyReason) return emptySet(catalogue, deviceIds, emptyReason, membership?.role ?? null);

  const roleBaseline = loadRoleBaseline(db, membership.role);
  const nowIso = now.toISOString();

  const allGrants = db
    .prepare(
      `SELECT gp.permission AS pattern, g.effect, g.device_id AS deviceId, g.id AS grantId
       FROM grants g
       JOIN grant_permissions gp ON gp.grant_id = g.id
       WHERE g.org_id = ? AND g.user_id = ? AND g.revoked_at IS NULL
         AND (g.starts_at IS NULL OR g.starts_at <= ?)
         AND (g.expires_at IS NULL OR g.expires_at > ?)`
    )
    .all(orgId, userId, nowIso, nowIso);

  const byDevice = {};
  for (const deviceId of deviceIds) {
    const rowsForDevice = allGrants.filter((r) => r.deviceId === null || r.deviceId === deviceId);
    const permissions = {};
    for (const perm of catalogue) {
      const matching = rowsForDevice
        .filter((r) => r.pattern === perm.key || r.pattern === `${perm.resource}:*` || r.pattern === '*')
        .map((r) => ({ ...r, permKey: perm.key }));
      permissions[perm.key] = decide(matching, perm.key, roleBaseline, membership.role);
    }
    byDevice[deviceId] = permissions;
  }

  return { role: membership.role, byDevice };
}

export function can(db, ctx, permission, deviceId = null) {
  return resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId }).permissions[permission]?.effect === 'allow';
}

// Throws 403 carrying the reason code, so a refusal is debuggable.
export function assertCan(db, ctx, permission, deviceId = null) {
  const decision = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId }).permissions[permission];
  if (decision.effect !== 'allow') {
    const reason = decision.reason === 'explicit_deny' ? 'explicit_deny' : 'missing_permission';
    auditDeny(db, ctx, { action: permission.replace(':', '.'), targetType: deviceId ? 'device' : null, targetId: deviceId, reasonCode: reason });
    throw forbidden(`missing ${permission}`, reason);
  }
  return decision;
}

// No privilege laundering: you may only grant authority you hold at that scope.
export function assertMayGrant(db, ctx, patterns, deviceId = null) {
  const catalogue = loadCatalogue(db);
  const { permissions: held } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });

  for (const pattern of patterns) {
    const keys =
      pattern === '*'
        ? catalogue.map((p) => p.key)
        : pattern.endsWith(':*')
          ? catalogue.filter((p) => `${p.resource}:*` === pattern).map((p) => p.key)
          : [pattern];

    for (const key of keys) {
      if (held[key]?.effect !== 'allow') {
        auditDeny(db, ctx, { action: 'grant.create', targetType: 'grant', reasonCode: 'missing_permission' });
        throw forbidden(`cannot grant ${pattern}: you do not hold ${key} at this scope`, 'missing_permission');
      }
    }
  }
}

// The compound check: session:start AND the permission for the requested mode, and a
// refusal must distinguish WHICH of the two was missing.
export function assertCanStartSession(db, ctx, mode, deviceId) {
  const modePermission = MODE_PERMISSION[mode];
  const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });

  if (permissions['session:start'].effect !== 'allow') {
    auditDeny(db, ctx, { action: 'session.start', targetType: 'device', targetId: deviceId, reasonCode: 'missing_permission' });
    throw forbidden('missing session:start', 'missing_permission');
  }
  if (permissions[modePermission].effect !== 'allow') {
    auditDeny(db, ctx, { action: 'session.start', targetType: 'device', targetId: deviceId, reasonCode: 'missing_device_permission' });
    throw forbidden(`missing ${modePermission}`, 'missing_device_permission');
  }
}
