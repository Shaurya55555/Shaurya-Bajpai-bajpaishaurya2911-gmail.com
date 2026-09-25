import React, { useEffect, useState } from 'react';
import { get, post, patch, del } from '../api.js';

const ROLES = ['owner', 'admin', 'operator', 'auditor', 'viewer'];

export function PeopleView({ token, orgId, permissions }) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState(null);
  const [inviting, setInviting] = useState(false);

  async function load() {
    try {
      const { members } = await get(`/orgs/${orgId}/members`, token);
      setMembers(members);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, [orgId]);

  const canInvite = permissions['user:invite']?.effect === 'allow';
  const canChangeRole = permissions['user:role:update']?.effect === 'allow';
  const canRemove = permissions['user:remove']?.effect === 'allow';

  async function invite(email, role) {
    await post(`/orgs/${orgId}/invites`, token, { email, role });
    setInviting(false);
  }

  async function changeRole(userId, role) {
    try {
      await patch(`/orgs/${orgId}/members/${userId}`, token, { role });
      load();
    } catch (err) {
      window.alert(err.message);
    }
  }

  async function toggleSuspend(member) {
    if (member.status === 'suspended') {
      await del(`/orgs/${orgId}/members/${member.userId}/suspend`, token);
    } else {
      await post(`/orgs/${orgId}/members/${member.userId}/suspend`, token);
    }
    load();
  }

  async function remove(member) {
    if (!window.confirm(`Remove ${member.name}?`)) return;
    try {
      await del(`/orgs/${orgId}/members/${member.userId}`, token);
      load();
    } catch (err) {
      window.alert(err.message);
    }
  }

  if (error) return <p role="alert">{error}</p>;
  if (!members) return null;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>People</h2>
        {canInvite && (
          <button data-testid="invite-user" onClick={() => setInviting((v) => !v)}>
            + Invite
          </button>
        )}
      </div>

      {inviting && <InviteForm onInvite={invite} />}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {members.map((m) => (
            <tr data-testid="user-row" data-user-id={m.userId} key={m.userId} style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              <td style={{ padding: '8px 4px' }}>
                {m.name} <span style={{ color: '#98a2b3', fontSize: 12 }}>({m.email}{m.status !== 'active' ? `, ${m.status}` : ''})</span>
              </td>
              <td style={{ padding: '8px 4px' }}>
                {canChangeRole ? (
                  <select data-testid="role-select" value={m.role} onChange={(e) => changeRole(m.userId, e.target.value)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  m.role
                )}
              </td>
              <td style={{ padding: '8px 4px' }}>
                {canRemove && (
                  <>
                    <button data-testid="suspend-user" onClick={() => toggleSuspend(m)} style={{ marginRight: 6 }}>
                      {m.status === 'suspended' ? 'Reinstate' : 'Suspend'}
                    </button>
                    <button data-testid="remove-user" onClick={() => remove(m)}>
                      Remove
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function InviteForm({ onInvite }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onInvite(email, role);
      }}
      style={{ marginBottom: 12 }}
    >
      <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginRight: 6 }} />
      <select value={role} onChange={(e) => setRole(e.target.value)} style={{ marginRight: 6 }}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button type="submit">Send invite</button>
    </form>
  );
}
