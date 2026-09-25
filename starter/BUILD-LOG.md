# BUILD-LOG

Append to this as you go. Commit it with the code it describes — the timestamps are part of the
evidence, and a log that arrives in one commit at the end reads as what it is.

Five lines is a real entry. Short and dated is better than long and reconstructed.

The categories we look for are listed in `DISCOVERY-BRIEF.md`. The example below shows the
*shape* of a good entry; it is a recreation of something already printed in `README.md`, so it
gives nothing away.

---

## 2026-09-26 · Phase 0 — orientation

Expected `npm install` to be a no-op. Observed: `better-sqlite3@11.10.0` tried to compile
from source and failed — no Visual Studio toolchain on this machine, and no prebuilt
binary published for this Node version (v26.7.0) at that package version. Changed: bumped
`better-sqlite3` to `^13.0.3` in `package.json`, which ships a prebuild matching this
Node ABI; `npm install` then succeeded with zero compilation. Verified by loading the
module standalone (`new Database(':memory:')`, `PRAGMA quick_check`) before touching any
app code. Note: this is a devDependency version, not `db/schema.sql` — the "don't edit
the schema" rule doesn't apply, but I still treated it as a decision worth a paper trail
rather than a silent fix.

## 2026-09-26 · Phase 1 — token verification

Expected the algorithm-confusion cases (`alg: none`, HS512/RS256 substitution) to be the
hard part. Observed: they weren't — checking `header.alg !== 'HS256'` after parsing but
before ever branching on it kills all of them in one line, because verification always
runs HMAC-SHA256 regardless of what the header claims. The genuinely fiddly case was
`base64url` decoding of a garbage signature string (`!!!not-base64!!!`) — Node's
`Buffer.from(str, 'base64url')` doesn't throw on invalid characters, it silently
truncates/reinterprets them, so I couldn't rely on a decode exception and instead added
an explicit length check against the expected HMAC digest length before
`timingSafeEqual` (which itself throws on mismatched buffer lengths). `node
scripts/check-jwt.js`: 43/43 on first run once that length check was in.

## 2026-09-26 · Phase 2 — caller context and the resolution engine

Started with the model "a suspended or removed membership should be rejected in
`context.js`, at authentication time, before it ever reaches permission resolution." That
broke against `AUTH-DATA-MODEL.md` §10 directly stating a suspended membership gets
`403` with an *empty permission set*, not `401` — meaning the caller must still be
successfully authenticated and handed to the routes, and the emptiness has to come from
`permissions.js`, not from a rejection in `context.js`. Moved the suspended case out of
`context.js` entirely; only `status === 'removed'` is rejected there (`401`), since a
removed membership means "not a member" outright, while suspended means "a member with
nothing." Confirmed by `check-permissions.js`'s suspended-membership block: `effect:
'deny'` with `reason: 'suspended'` for every permission, no 401 anywhere in that test.

Also had to decide what "resolved the same way" means for the org-level (`deviceId:
null`) vs device-level query, since the spec states the intent but not the mechanism.
Argued in `DECISIONS.md` under "the org-level view relaxes the device filter rather than
unioning per device."

`check-permissions.js`: 35/35. `check-personalisation.js`: 18/18 against fingerprint
`bb339819425c` (undocumented role `reviewer`, undocumented permission `device:reboot`) —
confirms the engine reads `roles`/`permissions`/`role_permissions`/`permission_patterns`
from the tables rather than assuming the documented 5-role/19-permission matrix.

One thing I checked and did *not* have to fix: `.candidate-nonce` is committed in this
repo with a fixed value, which I briefly suspected meant every fork shares an identical
"personalized" fixture. `scripts/personalise.js`'s own header comment says this is
deliberate — "the committed nonce is one instance, grading runs with a different one" —
so no action was needed, just a wasted five minutes confirming it.

## Phase 3 — orgs, members, invites

_Anything you had to work out that no document states. Invite lifecycle states are a common
source of this._

## Phase 4 — devices and grants

_What happens at the boundary where two grants disagree, or where a grant's scope and the
question's scope differ? Say what you predicted and what you got._

## Phase 5 — sessions

_Two permissions, one device. What did you have to resolve, and in what order, to keep the two
failure reasons distinguishable?_

## Phase 6 — audit

_What did you decide counts as an auditable event, and what pushed you to that line?_

## Phase 7 — the console

_Where did the server's answer and your instinct disagree about what should be on screen?_

## Phase 8 — hardening

_What did you measure, what did you fix, and what did you deliberately leave alone? Anything you
chose not to build belongs here with its reason._

## 2026-09-26 · Phase 3/4 — routes: orgs, members, invites, devices, grants, sessions, audit

Expected `assertCanModify` (strictly-lower-rank-only) to be right because it's the literal
reading of `PERMISSIONS.md` §6's example (admin->admin is 403). Observed: `check-api.js`'s
"demoting a NON-last owner is allowed" case has an *owner* demoting *another owner* and
expects `200`, which my strict rank comparison rejected as equal-rank. Changed: owner-on-
owner is now an explicit exception in `assertCanModify` — owner is the apex rank, so if
two owners exist, no *higher* rank exists to arbitrate between them, and blocking it would
make a redundant owner un-demotable except by resigning themselves; `assertNotLastOwner`
already guards the actual danger (dropping to zero owners). Logged the reasoning in
`DECISIONS.md` since this reads as a real disagreement with the section's own stated
example, not just an implementation detail.

Two bugs `check-api.js` caught directly, not by inspection:
1. `DEVICE_BUSY` mapping matched on the unique index's *name*
   (`one_exclusive_session_per_device`) in the SQLite error message, but better-sqlite3's
   actual message is `UNIQUE constraint failed: sessions.device_id` — no index name in it
   at all. First concurrent-session test failed with a raw `500 INTERNAL` instead of `409
   DEVICE_BUSY` until I matched on the table.column string instead.
2. The audit pagination test calls `?limit=200` expecting `200 OK` in the "audit records
   denied attempts" block, then separately tests `?limit=99999 -> 400` in the boundary
   block. I'd set the cap at 100, which passed the boundary test but failed the earlier
   one at 200. Moved the cap to 500 — comfortably between the two.

Also hit a real environment bug, unrelated to my code: `scripts/load-db.js`'s `here()`
helper builds a file path with `new URL(p, import.meta.url).pathname`, which on Windows
produces `/D:/Projects/...` (a leading slash before the drive letter). Passing that
string to `readFileSync` resolved to a doubled `D:\D:\Projects\...` path and failed with
ENOENT. `check-permissions.js` and `check-personalisation.js` never hit this because they
pass the `URL` object itself to `readFileSync`, which Node resolves correctly cross-
platform — so I changed `here()` to return the `URL` instead of extracting `.pathname`.
This doesn't touch `db/schema.sql`/`db/reference.sql` (still load-bearing, unmodified) —
just a path-handling bug in the loader script, which is tooling, not the exercise.

`check-api.js`: 66/66 after both fixes.

## Open threads

_Things you know are wrong, unfinished, or that you would do differently with another day. Listing
these honestly is worth more than pretending they do not exist — we will find them anyway._
