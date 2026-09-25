import React, { useState } from 'react';

export function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onLogin(email, password);
    } catch (err) {
      // Shown verbatim: the server already gives a wrong-password and an unknown-account
      // the same message, so the client must not "improve" on it (UI-INVENTORY.md §4).
      setError(err.message || 'sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main data-testid="login-form" style={{ maxWidth: 360, margin: '80px auto', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <h1 style={{ marginBottom: 24 }}>RemoteOps</h1>
      <form onSubmit={submit}>
        <label style={{ display: 'block', marginBottom: 12 }}>
          Email
          <input
            data-testid="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ display: 'block', width: '100%', padding: 8, marginTop: 4 }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          Password
          <input
            data-testid="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ display: 'block', width: '100%', padding: 8, marginTop: 4 }}
          />
        </label>
        <button data-testid="login-submit" type="submit" disabled={busy} style={{ padding: '8px 16px' }}>
          Sign in
        </button>
        {error && (
          <p data-testid="login-error" role="alert" style={{ color: '#b42318', marginTop: 12 }}>
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
