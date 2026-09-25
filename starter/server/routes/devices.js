import { badRequest, forbidden, notFound, grantExpired, normalizeTs, send } from '../http.js';
import { newId, nowIso, bumpPermVersion } from '../db.js';
import { resolve, resolveDevices, assertCan, assertMayGrant } from '../permissions.js';
import { endActiveSessions } from '../lifecycle.js';
import { audit } from '../audit.js';

const KINDS = ['macos', 'windows', 'linux', 'android', 'ios'];

function loadOrg(db, orgId) {
  const org = db.prepare(`SELECT * FROM organizations WHERE id = ? AND deleted_at IS NULL`).get(orgId);
  if (!org) throw notFound();
  return org;
}

function loadDevice(db, orgId, deviceId) {
  const device = db.prepare(`SELECT * FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL`).get(deviceId, orgId);
  if (!device) throw notFound();
  return device;
}

export function registerDeviceRoutes(router, { db }) {
  router.get('/v1/orgs/:org/devices', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'device:list');

    const devices = db.prepare(`SELECT * FROM devices WHERE org_id = ? AND deleted_at IS NULL`).all(params.org);
    const { byDevice } = resolveDevices(db, { userId: ctx.userId, orgId: params.org, deviceIds: devices.map((d) => d.id) });

    // device:view decides row inclusion. Absent, not redacted (UI-INVENTORY.md §1.3).
    const visible = devices
      .filter((d) => byDevice[d.id]['device:view']?.effect === 'allow')
      .map((d) => ({ id: d.id, name: d.name, kind: d.kind, online: !!d.online, permissions: byDevice[d.id] }));

    send(res, 200, { devices: visible });
  });

  router.get('/v1/orgs/:org/devices/:id', (ctx, params, res) => {
    loadOrg(db, params.org);
    const device = loadDevice(db, params.org, params.id);
    const { permissions } = resolve(db, { userId: ctx.userId, orgId: params.org, deviceId: device.id });
    if (permissions['device:view']?.effect !== 'allow') throw notFound();

    send(res, 200, { id: device.id, name: device.name, kind: device.kind, online: !!device.online, permissions });
  });

  router.post('/v1/orgs/:org/devices', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'device:provision');

    const { name, kind } = ctx.body ?? {};
    if (!name || typeof name !== 'string') throw badRequest('name is required');
    if (!KINDS.includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);

    const id = newId('dev');
    db.prepare(`INSERT INTO devices (id, org_id, name, kind) VALUES (?, ?, ?, ?)`).run(id, params.org, name, kind);
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'device.provision', targetType: 'device', targetId: id, result: 'allow' });

    send(res, 201, { id, name, kind, online: false });
  });

  router.patch('/v1/orgs/:org/devices/:id', (ctx, params, res) => {
    loadOrg(db, params.org);
    const device = loadDevice(db, params.org, params.id);
    assertCan(db, ctx, 'device:update', device.id);

    const { name, online } = ctx.body ?? {};
    const nextName = name ?? device.name;
    const nextOnline = typeof online === 'boolean' ? (online ? 1 : 0) : device.online;

    db.prepare(`UPDATE devices SET name = ?, online = ? WHERE id = ?`).run(nextName, nextOnline, device.id);
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'device.update', targetType: 'device', targetId: device.id, result: 'allow' });

    send(res, 200, { id: device.id, name: nextName, kind: device.kind, online: !!nextOnline });
  });

  router.delete('/v1/orgs/:org/devices/:id', (ctx, params, res) => {
    loadOrg(db, params.org);
    const device = loadDevice(db, params.org, params.id);
    assertCan(db, ctx, 'device:provision', device.id);

    db.prepare(`UPDATE devices SET deleted_at = ? WHERE id = ?`).run(nowIso(), device.id);
    // Decommission is a tenancy event, so it cascades — same end_reason as transfer
    // (PERMISSIONS.md §7.2's table maps both to 'device_transferred').
    endActiveSessions(db, { deviceId: device.id, reason: 'device_transferred' });
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'device.decommission', targetType: 'device', targetId: device.id, result: 'allow' });

    send(res, 200, { id: device.id });
  });

  router.post('/v1/orgs/:org/devices/:id/transfer', (ctx, params, res) => {
    loadOrg(db, params.org);
    const device = loadDevice(db, params.org, params.id);
    assertCan(db, ctx, 'device:provision', device.id);

    const { targetOrgId } = ctx.body ?? {};
    if (!targetOrgId) throw badRequest('targetOrgId is required');
    loadOrg(db, targetOrgId);

    const { permissions: targetPerms } = resolve(db, { userId: ctx.userId, orgId: targetOrgId });
    if (targetPerms['device:provision']?.effect !== 'allow') {
      throw forbidden('missing device:provision in the target organization', 'missing_permission');
    }

    db.prepare(`UPDATE devices SET org_id = ? WHERE id = ?`).run(targetOrgId, device.id);
    endActiveSessions(db, { deviceId: device.id, reason: 'device_transferred' });
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'device.transfer', targetType: 'device', targetId: device.id, result: 'allow' });
    audit(db, { orgId: targetOrgId, actorId: ctx.userId, action: 'device.transfer', targetType: 'device', targetId: device.id, result: 'allow' });

    send(res, 200, { id: device.id, orgId: targetOrgId });
  });

  router.post('/v1/orgs/:org/grants', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'grant:create');

    const { userId, deviceId = null, effect, permissions, startsAt, expiresAt } = ctx.body ?? {};
    if (!userId) throw badRequest('userId is required');
    if (effect !== 'allow' && effect !== 'deny') throw badRequest('effect must be "allow" or "deny"');
    if (!Array.isArray(permissions) || permissions.length === 0) throw badRequest('permissions must be a non-empty array');
    if (userId === ctx.userId) throw forbidden('cannot grant to yourself', 'self_grant');

    // Rejected as a controlled 400 here, ahead of the insert, rather than surfacing the
    // grant_permissions FK's raw SQLITE_CONSTRAINT failure — same table, same authority,
    // just a clean HTTP shape (D19).
    for (const p of permissions) {
      if (!db.prepare(`SELECT 1 FROM permission_patterns WHERE pattern = ?`).get(p)) {
        throw badRequest(`unknown permission: ${p}`, 'unknown_permission');
      }
    }

    const targetMember = db
      .prepare(`SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'`)
      .get(params.org, userId);
    if (!targetMember) throw notFound();

    if (deviceId && !db.prepare(`SELECT 1 FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL`).get(deviceId, params.org)) {
      throw notFound();
    }

    const startsIso = normalizeTs(startsAt, 'startsAt');
    const expiresIso = normalizeTs(expiresAt, 'expiresAt');
    if (expiresIso && new Date(expiresIso).getTime() <= Date.now()) throw grantExpired();

    // No laundering: the granter may only hand out authority they hold at this scope.
    assertMayGrant(db, ctx, permissions, deviceId);

    const id = newId('grt');
    db.prepare(
      `INSERT INTO grants (id, org_id, user_id, device_id, effect, starts_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, params.org, userId, deviceId, effect, startsIso, expiresIso, ctx.userId);
    for (const p of permissions) {
      db.prepare(`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`).run(id, p);
    }
    bumpPermVersion(db, { orgId: params.org, userId });
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'grant.create', targetType: 'grant', targetId: id, result: 'allow' });

    send(res, 201, { id, userId, deviceId, effect, permissions, startsAt: startsIso, expiresAt: expiresIso });
  });

  router.get('/v1/orgs/:org/grants', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'user:read');

    const rows = db
      .prepare(
        `SELECT g.id, g.user_id AS userId, g.device_id AS deviceId, g.effect, g.starts_at AS startsAt, g.expires_at AS expiresAt,
                GROUP_CONCAT(gp.permission) AS permissionsCsv
         FROM grants g LEFT JOIN grant_permissions gp ON gp.grant_id = g.id
         WHERE g.org_id = ? AND g.revoked_at IS NULL
         GROUP BY g.id ORDER BY g.created_at DESC`
      )
      .all(params.org);

    send(res, 200, {
      grants: rows.map((g) => ({ ...g, permissions: g.permissionsCsv ? g.permissionsCsv.split(',') : [] })),
    });
  });

  router.delete('/v1/orgs/:org/grants/:id', (ctx, params, res) => {
    loadOrg(db, params.org);
    assertCan(db, ctx, 'grant:revoke');

    const grant = db.prepare(`SELECT * FROM grants WHERE id = ? AND org_id = ? AND revoked_at IS NULL`).get(params.id, params.org);
    if (!grant) throw notFound();

    db.prepare(`UPDATE grants SET revoked_at = ? WHERE id = ?`).run(nowIso(), grant.id);
    bumpPermVersion(db, { orgId: params.org, userId: grant.user_id });
    audit(db, { orgId: params.org, actorId: ctx.userId, action: 'grant.revoke', targetType: 'grant', targetId: grant.id, result: 'allow' });

    send(res, 200, { id: grant.id });
  });
}
