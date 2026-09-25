import { badRequest, notFound, deviceBusy, send } from '../http.js';
import { newId, nowIso } from '../db.js';
import { assertCan, assertCanStartSession } from '../permissions.js';
import { snapshotAuthority, sessionExpiry } from '../lifecycle.js';
import { audit } from '../audit.js';

const MODES = ['view', 'control', 'terminal'];

function loadOrg(db, orgId) {
  const org = db.prepare(`SELECT * FROM organizations WHERE id = ? AND deleted_at IS NULL`).get(orgId);
  if (!org) throw notFound();
  return org;
}

const SESSION_COLUMNS = `id, org_id, user_id, device_id, mode, state, end_reason, started_at, expires_at, ended_at`;

export function registerSessionRoutes(router, { db }) {
  router.post('/v1/orgs/:org/sessions', (ctx, params, res) => {
    loadOrg(db, params.org);

    const { deviceId, mode } = ctx.body ?? {};
    if (!deviceId || !MODES.includes(mode)) throw badRequest('deviceId and a valid mode are required');

    const device = db.prepare(`SELECT 1 FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL`).get(deviceId, params.org);
    if (!device) throw notFound();

    // Throws 403 with a reason that distinguishes "can't start sessions at all" from
    // "not on this device" (BRIEF.md §3.1).
    assertCanStartSession(db, ctx, mode, deviceId);

    const id = newId('ses');
    const startedAt = nowIso();
    const expiresAt = sessionExpiry(db, params.org);
    const authorizedBy = snapshotAuthority(db, { userId: ctx.userId, orgId: params.org, deviceId });

    try {
      db.prepare(
        `INSERT INTO sessions (id, org_id, user_id, device_id, mode, state, authorized_by, started_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      ).run(id, params.org, ctx.userId, deviceId, mode, authorizedBy, startedAt, expiresAt);
    } catch (err) {
      // The database is the arbiter (D10): two parallel exclusive requests race here,
      // and only one INSERT can win the partial unique index. We don't check-then-act.
      if (String(err.code).startsWith('SQLITE_CONSTRAINT') && String(err.message).includes('sessions.device_id')) {
        throw deviceBusy();
      }
      throw err;
    }

    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'session.start', targetType: 'device', targetId: deviceId, result: 'allow' });

    send(res, 201, { id, org_id: params.org, user_id: ctx.userId, device_id: deviceId, mode, state: 'active', started_at: startedAt, expires_at: expiresAt, end_reason: null });
  });

  router.get('/v1/orgs/:org/sessions', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'session:view');

    const sessions = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE org_id = ? ORDER BY started_at DESC`).all(params.org);
    send(res, 200, { sessions });
  });

  // No :org in the path — a session's org comes from the row itself, and a mismatch
  // against the caller's token org is invisible (404), same rule as everywhere else.
  router.get('/v1/sessions/:id', (ctx, params, res) => {
    const session = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(params.id);
    if (!session || session.org_id !== ctx.orgId) throw notFound();
    if (session.user_id !== ctx.userId) assertCan(db, ctx, 'session:view');

    send(res, 200, session);
  });

  router.delete('/v1/sessions/:id', (ctx, params, res) => {
    const session = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(params.id);
    if (!session || session.org_id !== ctx.orgId) throw notFound();

    const isOwn = session.user_id === ctx.userId;
    if (!isOwn) assertCan(db, ctx, 'session:terminate');

    const reason = isOwn ? 'user_stopped' : 'admin_terminated';
    db.prepare(`UPDATE sessions SET state = 'ended', ended_at = ?, end_reason = ? WHERE id = ? AND state = 'active'`)
      .run(nowIso(), reason, session.id);
    audit(db, { orgId: session.org_id, actorId: ctx.userId, action: 'session.stop', targetType: 'session', targetId: session.id, result: 'allow' });

    const updated = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(session.id);
    send(res, 200, updated);
  });
}
