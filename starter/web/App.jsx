import React, { useEffect, useState, useCallback } from 'react';
import { post, get, ApiError } from './api.js';
import { LoginPage } from './components/LoginPage.jsx';
import { InvitePage } from './components/InvitePage.jsx';
import { Shell } from './components/Shell.jsx';

// The invite route is a plain path check, not a router dependency — one extra route
// doesn't earn a routing library.
function inviteTokenFromPath() {
  const m = /^\/invite\/(.+)$/.exec(window.location.pathname);
  return m ? m[1] : null;
}

export function App() {
  const [session, setSession] = useState(null); // { token, userId, orgId, role, orgs, permissions }
  const [booting, setBooting] = useState(true);
  const inviteToken = inviteTokenFromPath();

  const hydrate = useCallback(async (token) => {
    const me = await get('/auth/me', token);
    setSession({ token, ...me });
  }, []);

  useEffect(() => {
    if (inviteToken) {
      setBooting(false);
      return;
    }
    // A reload has no in-memory token left, but the refresh cookie survives it
    // (AUTH-DATA-MODEL.md §2) — this is what restores the session silently.
    (async () => {
      try {
        const { token } = await post('/auth/refresh', null);
        await hydrate(token);
      } catch {
        // No valid cookie yet, or it's expired: fall through to the login screen.
      } finally {
        setBooting(false);
      }
    })();
  }, [hydrate, inviteToken]);

  const login = useCallback(
    async (email, password) => {
      const { token } = await post('/auth/login', null, { email, password });
      await hydrate(token);
    },
    [hydrate]
  );

  const switchOrg = useCallback(
    async (orgId) => {
      const { token } = await post('/auth/token', session.token, { orgId });
      await hydrate(token);
    },
    [session, hydrate]
  );

  const createOrg = useCallback(
    async (name) => {
      const created = await post('/orgs', session.token, { name });
      const { token } = await post('/auth/token', session.token, { orgId: created.id });
      await hydrate(token);
    },
    [session, hydrate]
  );

  const signOut = useCallback(() => setSession(null), []);

  if (inviteToken) return <InvitePage token={inviteToken} />;
  if (booting) return null;
  if (!session) return <LoginPage onLogin={login} />;

  return (
    <Shell
      session={session}
      onSwitchOrg={switchOrg}
      onCreateOrg={createOrg}
      onSignOut={signOut}
      refreshSession={() => hydrate(session.token)}
    />
  );
}

export { ApiError };
