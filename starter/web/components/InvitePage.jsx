import React, { useEffect, useState } from 'react';
import { get, post } from '../api.js';

export function InvitePage({ token }) {
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [submitError, setSubmitError] = useState(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    get(`/invites/${token}`, null)
      .then(setInvite)
      .catch(() => setError('This invite link is invalid or has expired.'));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setSubmitError(null);
    try {
      await post(`/invites/${token}/accept`, null, { name, password });
      setAccepted(true);
      window.location.href = '/';
    } catch (err) {
      setSubmitError(err.message || 'could not accept the invite');
    }
  }

  if (accepted) return null; // navigating away

  if (error) {
    return (
      <main style={{ maxWidth: 360, margin: '80px auto', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
        <p data-testid="invite-error" role="alert" style={{ color: '#b42318' }}>
          {error}
        </p>
      </main>
    );
  }

  if (!invite) return null;

  return (
    <main style={{ maxWidth: 360, margin: '80px auto', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <h1 style={{ marginBottom: 4 }}>You're invited</h1>
      <p style={{ color: '#5b6270', marginTop: 0 }}>
        Join <strong>{invite.orgName}</strong> as <span data-testid="invite-role">{invite.role}</span>.
      </p>
      <form onSubmit={submit}>
        <label style={{ display: 'block', marginBottom: 12 }}>
          Email
          <input data-testid="invite-email" value={invite.email} readOnly style={{ display: 'block', width: '100%', padding: 8, marginTop: 4 }} />
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          Name
          <input
            data-testid="invite-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ display: 'block', width: '100%', padding: 8, marginTop: 4 }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          Password
          <input
            data-testid="invite-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ display: 'block', width: '100%', padding: 8, marginTop: 4 }}
          />
        </label>
        <button data-testid="invite-submit" type="submit" style={{ padding: '8px 16px' }}>
          Join
        </button>
        {submitError && (
          <p role="alert" style={{ color: '#b42318', marginTop: 12 }}>
            {submitError}
          </p>
        )}
      </form>
    </main>
  );
}
