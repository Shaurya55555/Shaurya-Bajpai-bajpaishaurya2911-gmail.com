// Shared domain rules: role ranks, last-owner protection, ending sessions.
//
// YOURS TO WRITE. This file ships as a stub.
//
// Put here the rules more than one route needs, so "what ends a session" has exactly
// one implementation. Sources: PERMISSIONS.md §7.2 and D8.
//
// Two traps worth naming before you start:
//   - `roles.rank` is MODIFICATION AUTHORITY ONLY. It must never answer a can()
//     question. operator and auditor are unordered by permission, and ranking them is
//     the modelling error the auditor role exists to catch.
//   - a permission change does NOT end a session in flight (grantfathering). Suspension,
//     membership removal and device transfer DO. See PERMISSIONS.md §7.

import { badRequest, forbidden, lastOwner } from './http.js';
import { nowIso } from './db.js';
import { resolve } from './permissions.js';

export function roleRanks(db) {
  return Object.fromEntries(db.prepare(`SELECT key, rank FROM roles`).all().map((r) => [r.key, r.rank]));
}

export function assertRoleExists(db, role) {
  const row = db.prepare(`SELECT 1 FROM roles WHERE key = ?`).get(role);
  if (!row) throw badRequest(`unknown role: ${role}`);
}

// Modification authority only (D8) — never a stand-in for permission resolution. The
// caller may act on someone of a strictly lower rank; equal or higher is 403 — EXCEPT
// owner-on-owner, which has to be allowed: owner is the apex rank, so if two owners
// exist and one needs to be demoted or removed, no higher rank exists to do it. The
// generic "equal rank is 403" reading (PERMISSIONS.md §6's own example is admin->admin)
// would make demoting a redundant owner impossible, which last-owner protection already
// guards against separately — see assertNotLastOwner.
export function assertCanModify(db, callerRole, targetRole) {
  const ranks = roleRanks(db);
  const allowed = ranks[callerRole] > ranks[targetRole] || (callerRole === 'owner' && targetRole === 'owner');
  if (!allowed) {
    throw forbidden('cannot modify a member of equal or higher rank', 'insufficient_rank');
  }
}

export function assertNotLastOwner(db, orgId, userId) {
  const member = db
    .prepare(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'`)
    .get(orgId, userId);
  if (!member || member.role !== 'owner') return;

  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'`)
    .get(orgId);
  if (n <= 1) throw lastOwner();
}

// Tenancy events cascade; permission tweaks don't (PERMISSIONS.md §7). This is the one
// place "what ends a session" lives, called from suspension, removal and device-transfer
// routes — never duplicated per route.
export function endActiveSessions(db, { orgId, userId, deviceId, reason, exceptSessionId = null }) {
  const clauses = [`state = 'active'`];
  const params = [];
  if (orgId) { clauses.push('org_id = ?'); params.push(orgId); }
  if (userId) { clauses.push('user_id = ?'); params.push(userId); }
  if (deviceId) { clauses.push('device_id = ?'); params.push(deviceId); }
  if (exceptSessionId) { clauses.push('id != ?'); params.push(exceptSessionId); }

  db.prepare(`UPDATE sessions SET state = 'ended', ended_at = ?, end_reason = ? WHERE ${clauses.join(' AND ')}`)
    .run(nowIso(), reason, ...params);
}

// The authority snapshot stored on `sessions.authorized_by`. Sessions are grandfathered
// (PERMISSIONS.md §7.1) — this is what "grandfathered" actually freezes.
export function snapshotAuthority(db, { userId, orgId, deviceId }) {
  const { role, permissions } = resolve(db, { userId, orgId, deviceId });
  return JSON.stringify({ role, permissions, snapshotAt: nowIso() });
}

export function sessionExpiry(db, orgId) {
  const org = db.prepare(`SELECT max_session_minutes FROM organizations WHERE id = ?`).get(orgId);
  const minutes = org?.max_session_minutes ?? 60;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
