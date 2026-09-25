import React, { useEffect, useState } from 'react';
import { get, post, del } from '../api.js';

export function GrantsView({ token, orgId, permissions }) {
  const [grants, setGrants] = useState(null);
  const [members, setMembers] = useState([]);
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const canCreate = permissions['grant:create']?.effect === 'allow';
  const canRevoke = permissions['grant:revoke']?.effect === 'allow';

  async function load() {
    try {
      const [g, m, d] = await Promise.all([
        get(`/orgs/${orgId}/grants`, token),
        get(`/orgs/${orgId}/members`, token),
        get(`/orgs/${orgId}/devices`, token),
      ]);
      setGrants(g.grants);
      setMembers(m.members);
      setDevices(d.devices);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, [orgId]);

  async function createGrant(payload) {
    await post(`/orgs/${orgId}/grants`, token, payload);
    setCreating(false);
    load();
  }

  async function revoke(id) {
    await del(`/orgs/${orgId}/grants/${id}`, token);
    load();
  }

  if (error) return <p role="alert">{error}</p>;
  if (!grants) return null;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Grants</h2>
        {canCreate && (
          <button data-testid="new-grant" onClick={() => setCreating((v) => !v)}>
            + New grant
          </button>
        )}
      </div>

      {creating && (
        <NewGrantForm members={members} devices={devices} allPermissions={Object.keys(permissions)} onSubmit={createGrant} />
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {grants.map((g) => (
            <tr data-testid="grant-row" data-effect={g.effect} data-grant-id={g.id} key={g.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              <td style={{ padding: '8px 4px' }}>{members.find((m) => m.userId === g.userId)?.name ?? g.userId}</td>
              <td style={{ padding: '8px 4px' }}>{g.deviceId ? devices.find((d) => d.id === g.deviceId)?.name ?? g.deviceId : 'org-wide'}</td>
              <td style={{ padding: '8px 4px', fontWeight: g.effect === 'deny' ? 700 : 400 }}>{g.effect}</td>
              <td style={{ padding: '8px 4px' }}>{g.permissions.join(', ')}</td>
              <td style={{ padding: '8px 4px' }}>
                {canRevoke && (
                  <button data-testid="revoke-grant" onClick={() => revoke(g.id)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function NewGrantForm({ members, devices, allPermissions, onSubmit }) {
  const [userId, setUserId] = useState(members[0]?.userId ?? '');
  const [deviceId, setDeviceId] = useState('');
  const [effect, setEffect] = useState('allow');
  const [picked, setPicked] = useState(new Set());

  function toggle(key) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ userId, deviceId: deviceId || null, effect, permissions: [...picked] });
      }}
      style={{ marginBottom: 16, padding: 12, border: '1px solid rgba(0,0,0,0.1)', borderRadius: 6 }}
    >
      <div style={{ marginBottom: 8 }}>
        <label>
          User{' '}
          <select data-testid="grant-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label>
          Device{' '}
          <select data-testid="grant-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">org-wide</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label>
          Effect{' '}
          <select data-testid="grant-effect" value={effect} onChange={(e) => setEffect(e.target.value)}>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
        </label>
      </div>
      <fieldset style={{ marginBottom: 8 }}>
        <legend>Permissions</legend>
        {allPermissions.map((key) => (
          <label key={key} style={{ display: 'block' }}>
            <input type="checkbox" data-permission-key={key} checked={picked.has(key)} onChange={() => toggle(key)} /> {key}
          </label>
        ))}
      </fieldset>
      <button data-testid="grant-submit" type="submit">
        Create grant
      </button>
    </form>
  );
}
