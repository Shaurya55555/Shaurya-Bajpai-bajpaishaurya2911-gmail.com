import React, { useState } from 'react';
import { patch, del } from '../api.js';

export function AdminView({ token, orgId, permissions, refreshSession }) {
  const [error, setError] = useState(null);
  const canUpdate = permissions['org:update']?.effect === 'allow';
  const canDelete = permissions['org:delete']?.effect === 'allow';

  async function rename() {
    const name = window.prompt('New organization name');
    if (!name) return;
    try {
      await patch(`/orgs/${orgId}`, token, { name });
      await refreshSession();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this organization? This cannot be undone.')) return;
    try {
      await del(`/orgs/${orgId}`, token);
      await refreshSession();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Admin</h2>
      {error && <p role="alert">{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        {canUpdate && (
          <button data-testid="rename-org" onClick={rename}>
            Rename organization
          </button>
        )}
        {canDelete && (
          <button data-testid="delete-org" onClick={remove}>
            Delete organization
          </button>
        )}
      </div>
    </section>
  );
}
