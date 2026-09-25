import React, { useEffect, useState } from 'react';
import { get, post, del } from '../api.js';

export function SessionsView({ token, orgId, userId, permissions }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  const canStart = permissions['session:start']?.effect === 'allow';
  const canTerminate = permissions['session:terminate']?.effect === 'allow';

  async function load() {
    try {
      const { sessions } = await get(`/orgs/${orgId}/sessions`, token);
      setSessions(sessions);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, [orgId]);

  async function newSession() {
    const deviceId = window.prompt('Device id');
    if (!deviceId) return;
    const mode = window.prompt('Mode (view, control, terminal)', 'view');
    if (!mode) return;
    try {
      await post(`/orgs/${orgId}/sessions`, token, { deviceId, mode });
      load();
    } catch (err) {
      window.alert(err.message);
    }
  }

  async function stop(id) {
    await del(`/sessions/${id}`, token);
    load();
  }

  if (error) return <p role="alert">{error}</p>;
  if (!sessions) return null;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Sessions</h2>
        {canStart && (
          <button data-testid="new-session" onClick={newSession}>
            + New session
          </button>
        )}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {sessions.map((s) => (
            <tr data-testid="session-row" data-session-id={s.id} data-state={s.state} key={s.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              <td style={{ padding: '8px 4px' }}>{s.device_id}</td>
              <td style={{ padding: '8px 4px' }}>{s.mode}</td>
              <td style={{ padding: '8px 4px' }}>{s.state}{s.end_reason ? ` (${s.end_reason})` : ''}</td>
              <td style={{ padding: '8px 4px' }}>
                {s.state === 'active' && (s.user_id === userId || canTerminate) && (
                  <button data-testid="stop-session" onClick={() => stop(s.id)}>
                    Stop
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
