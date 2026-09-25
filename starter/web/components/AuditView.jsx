import React, { useEffect, useState } from 'react';
import { get } from '../api.js';

export function AuditView({ token, orgId }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    get(`/orgs/${orgId}/audit?limit=100`, token)
      .then((r) => setEvents(r.events))
      .catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p role="alert">{error}</p>;
  if (!events) return null;

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Audit</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {events.map((e) => (
            <tr data-testid="audit-row" data-result={e.result} key={e.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              <td style={{ padding: '8px 4px', color: '#98a2b3', fontSize: 12 }}>{e.at}</td>
              <td style={{ padding: '8px 4px' }}>{e.action}</td>
              <td style={{ padding: '8px 4px', fontWeight: e.result === 'deny' ? 700 : 400 }}>{e.result}</td>
              <td style={{ padding: '8px 4px', color: '#98a2b3' }}>{e.reason_code ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
