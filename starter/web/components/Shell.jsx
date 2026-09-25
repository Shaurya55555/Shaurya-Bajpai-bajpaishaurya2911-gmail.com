import React, { useState } from 'react';
import { DevicesView } from './DevicesView.jsx';
import { PeopleView } from './PeopleView.jsx';
import { GrantsView } from './GrantsView.jsx';
import { SessionsView } from './SessionsView.jsx';
import { AuditView } from './AuditView.jsx';
import { AdminView } from './AdminView.jsx';

// Real, per-org, not a shared banner (BRIEF.md §3.2 point 2) — the background colour
// itself changes, which is what the UI test measures via getComputedStyle.
const THEME_COLORS = {
  cobalt: '#eef3ff',
  amber: '#fff7e6',
  moss: '#eef6ea',
  plum: '#f6eefb',
  rust: '#fdeee9',
  teal: '#e9f7f5',
};

const CARDS = [
  { key: 'devices', label: 'Devices', has: (p) => p['device:list']?.effect === 'allow' },
  { key: 'people', label: 'People', has: (p) => p['user:read']?.effect === 'allow' },
  { key: 'grants', label: 'Grants', has: (p) => p['user:read']?.effect === 'allow' },
  { key: 'sessions', label: 'Sessions', has: (p) => p['session:view']?.effect === 'allow' },
  { key: 'audit', label: 'Audit', has: (p) => p['audit:read']?.effect === 'allow' },
  { key: 'admin', label: 'Admin', has: (p) => p['org:update']?.effect === 'allow' || p['org:delete']?.effect === 'allow' },
];

export function Shell({ session, onSwitchOrg, onCreateOrg, onSignOut, refreshSession }) {
  const [activeTab, setActiveTab] = useState('devices');
  const currentOrg = session.orgs.find((o) => o.id === session.orgId);
  const theme = currentOrg?.theme ?? 'cobalt';

  const visibleCards = CARDS.filter((c) => c.has(session.permissions));
  if (!visibleCards.some((c) => c.key === activeTab)) {
    // The tab we were on just vanished (a permission changed, or we switched orgs).
    setActiveTab(visibleCards[0]?.key ?? 'devices');
  }

  async function handleCreateOrg() {
    const name = window.prompt('Organization name');
    if (name) await onCreateOrg(name);
  }

  const viewProps = { token: session.token, orgId: session.orgId, userId: session.userId, permissions: session.permissions, refreshSession };

  return (
    <div
      data-testid="app-shell"
      data-org-id={session.orgId}
      data-org-theme={theme}
      style={{ minHeight: '100vh', backgroundColor: THEME_COLORS[theme] ?? '#fff', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 20px', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
        <strong>{currentOrg?.name ?? 'RemoteOps'}</strong>
        <nav style={{ display: 'flex', gap: 8 }}>
          {session.orgs.map((org) => (
            <button
              key={org.id}
              data-testid="org-option"
              data-org-id={org.id}
              onClick={() => org.id !== session.orgId && onSwitchOrg(org.id)}
              aria-pressed={org.id === session.orgId}
              style={{ padding: '4px 10px', fontWeight: org.id === session.orgId ? 700 : 400 }}
            >
              {org.name}
            </button>
          ))}
          <button data-testid="create-org" onClick={handleCreateOrg} style={{ padding: '4px 10px' }}>
            + New org
          </button>
        </nav>
        <span style={{ marginLeft: 'auto' }}>
          role: <span data-testid="active-role">{session.role}</span>
        </span>
        <button data-testid="sign-out" onClick={onSignOut} style={{ padding: '4px 10px' }}>
          Sign out
        </button>
      </header>

      <div style={{ display: 'flex' }}>
        <aside style={{ width: 160, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {visibleCards.map((c) => (
            <button
              key={c.key}
              data-testid={`nav-${c.key}`}
              onClick={() => setActiveTab(c.key)}
              aria-current={activeTab === c.key}
              style={{ textAlign: 'left', padding: '6px 10px', background: activeTab === c.key ? 'rgba(0,0,0,0.06)' : 'transparent', border: 'none', borderRadius: 4 }}
            >
              {c.label}
            </button>
          ))}
        </aside>

        {/* Keyed on org + tab so switching either one is a real remount, not a
            silent prop update — this is what makes an active view refetch. */}
        <main style={{ flex: 1, padding: 20 }} key={`${session.orgId}:${activeTab}`}>
          {activeTab === 'devices' && <DevicesView {...viewProps} />}
          {activeTab === 'people' && <PeopleView {...viewProps} />}
          {activeTab === 'grants' && <GrantsView {...viewProps} />}
          {activeTab === 'sessions' && <SessionsView {...viewProps} />}
          {activeTab === 'audit' && <AuditView {...viewProps} />}
          {activeTab === 'admin' && <AdminView {...viewProps} />}
        </main>
      </div>
    </div>
  );
}
