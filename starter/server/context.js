// Per-request context: turn a bearer token into an authenticated caller.
//
// YOURS TO WRITE. This file ships as a stub so the server boots and every
// authenticated request fails loudly instead of appearing to work.
//
// What it has to do (BRIEF.md §3, PERMISSIONS.md §6):
//   - read the bearer token, verify it with verifyAccessToken() from ./auth.js
//   - look the membership up and refuse a token whose org or membership is gone
//   - THE TOKEN'S org CLAIM IS THE ONLY ORG THE CALLER MAY ADDRESS. A request that
//     names a different org is INVISIBLE — 404, never 403. Isolation is structural:
//     the caller cannot name another org, rather than being filtered afterwards.
//   - check freshness against memberships.perm_version (AUTH-DATA-MODEL.md §3), so a
//     role or grant change takes effect on the NEXT request, not at token expiry
//   - throw through the one error path in ./http.js
//
// authenticate(db, secret) returns (req, params) => caller, where caller carries at
// least { userId, orgId, role, membership, claims }.

import { verifyAccessToken, assertFresh } from './auth.js';
import { unauthenticated, notFound } from './http.js';

const BEARER = /^Bearer (.+)$/;

export function authenticate(db, secret) {
  return function buildContext(req, params) {
    const header = req.headers['authorization'];
    const match = typeof header === 'string' ? BEARER.exec(header) : null;
    if (!match) throw unauthenticated('missing bearer token');

    const claims = verifyAccessToken(match[1], secret);

    // The token's org claim is the only org this caller may address. A path that
    // names a different org is invisible, not forbidden — 404, never 403.
    if (params.org !== undefined && params.org !== claims.org) throw notFound();

    const membership = db
      .prepare(`SELECT * FROM memberships WHERE org_id = ? AND user_id = ?`)
      .get(claims.org, claims.sub);

    // Throws 401 UNAUTHENTICATED if there's no membership row at all, or 401
    // TOKEN_STALE if perm_version has moved on (role/grant change, suspension,
    // removal) since this token was issued.
    assertFresh(claims, membership);

    // A removed membership is gone, even though the row itself persists (users are
    // never deleted). Suspended is different: the caller is still identifiable, but
    // permissions.js resolves an empty set for them, which becomes 403 downstream —
    // it is not this layer's job to decide that.
    if (membership.status === 'removed') throw unauthenticated('membership removed');

    return {
      userId: claims.sub,
      orgId: claims.org,
      role: membership.role,
      membership,
      claims,
    };
  };
}
