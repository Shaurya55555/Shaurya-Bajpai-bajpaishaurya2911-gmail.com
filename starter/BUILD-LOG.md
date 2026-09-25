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

## 2026-09-26 · Phase 5 — the console

Built `web/` against `tests/ui.spec.js` directly rather than guessing at `UI-INVENTORY.md`
in isolation — the spec file is the actual grading contract for the shipped suite, and it
pins several things the prose leaves ambiguous (e.g. that switching orgs must produce a
*measurably different* `getComputedStyle` background colour, not just a different
`data-org-theme` attribute).

One design choice worth stating plainly: the "new grant" form's permission checkboxes are
generated from `Object.keys(session.permissions)` — the org-level permission map already
returned by `/auth/me` — rather than a hardcoded list of the 19 documented permissions.
Since `resolve()` iterates the full `permissions` table, this list already includes
whatever a personalized org's extra permission is, with no separate endpoint and no
client-side copy of the catalogue. Same principle as the server side, just showing up in
the UI layer this time.

Predicted the hardest test would be "an element vanishes when the server withdraws the
permission" (the one that intercepts the API response and checks the client re-renders
from it). It passed on the first run — because the active view is conditionally rendered
(`{activeTab === 'devices' && <DevicesView/>}`) rather than hidden with CSS, switching nav
tabs away and back is a genuine unmount/remount, which forces a real refetch. No special
handling was needed; the architecture that avoids a client-side permission table also
happens to make this test trivial.

Have not yet run `npx playwright test` end to end — see next entry once it finishes.

## 2026-09-26 · Phase 5 (cont.) — the same Windows path bug, in a *given* file this time

First `npx playwright test` run: all 25 tests failed, and not on an assertion — `getByTestId('login-email')` couldn't even be found, meaning the page never rendered anything. That's a loading failure, not a logic bug, so I checked the network layer directly instead of the React code: started `server/index.js` by hand in production mode and `curl`'d `/` and the built JS asset. Both came back `404 NOT_FOUND` from the app's own router, not a connection failure — so the server was up, but treating every static path as missing.

`server/index.js`'s `DIST` constant is built the exact same way as the `here()` helper I'd already fixed in `scripts/load-db.js`: `new URL('../dist/', import.meta.url).pathname`. Same bug, same cause — `.pathname` on Windows yields `/D:/Projects/...` (leading slash before the drive letter), and `path.join(DIST, rel)` built from that never resolves to a real file, so `stat()` throws, the SPA-fallback branch reads the same broken path and also fails, and everything 404s. This is in a file `BRIEF.md` §2 lists as *given* ("server/index.js — the request pipeline, and static/Vite serving"), not something the exercise asks me to write — but it doesn't run at all on this machine without the fix, so I patched it the same way: `fileURLToPath(new URL(...))` instead of `.pathname`.

Worth flagging on its own: this is the *second* instance of the identical bug pattern in given tooling (the first was `load-db.js`'s loader). Both share the same root cause and the same fix. If I hadn't already diagnosed the first one, this second failure — "the whole UI is dark, no error, nothing renders" — would have been a much harder one to trace back to a URL-to-path conversion two directories away from anything I'd written. Recognizing the pattern from the first incident is what made this a five-minute fix instead of a debugging session.

Verified with a manual `curl` against a hand-started server (on a scratch port, to rule out my curl commands ever hitting an earlier stale server process rather than the fixed code) before touching Playwright again. `npx playwright test`: 25/25 on the next run.

All four suites are now green: `check-jwt.js` 43/43, `check-permissions.js` 35/35, `check-api.js` 66/66, `check-personalisation.js` 18/18, `npx playwright test` 25/25 — 187/187 total.

## 2026-09-26 · Phase 6 — hardening: audit was silently success-only

Went through `PERMISSIONS.md` §9's "things that should always be true" list against the
actual code rather than against the passing test output, on the theory that a shipped
test proves its own assertion and nothing more. Invariant 9 — "audit is append-only, and
it records denied attempts as well as successful ones" — is exactly the kind of thing a
weak test can appear to cover without actually exercising: `check-api.js`'s "contains
denials" check only asserts that *some* deny row exists in the response, and the seeded
fixture (`seed/orgs.json`'s `aud_003`) already ships with one. Grepped my own routes:
`audit(db, ...)` is called 20 times across `server/routes/*.js`, and every single call
site passes `result: 'allow'`. `auditDenials()` in `audit.js` is exported and never
imported anywhere. Every `assertCan`/`assertMayGrant`/`assertCanStartSession` refusal —
which is to say every 403 this API has ever returned to a real caller — was going
completely unrecorded.

Fixed by moving the audit-on-deny call into the three `assert*` functions in
`permissions.js` themselves, rather than adding `audit()` calls to ~30 route handlers
individually. Same reasoning as putting `resolve()` in one place: a behaviour that has to
happen on every refusal is safer as one line inside the function that already produces
every refusal than as thirty call sites that each have to remember it. Verified with a
live request, not just by re-running the suites (which still pass unchanged — they were
never asserting the right thing here): started the server against a throwaway DB, logged
in as Sam (operator, no `audit:read` in Acme), hit `GET /orgs/org_acme/audit`, got the
expected `403`, then read the audit log back as Dana and found a fresh row —
`actor_id: usr_sam, action: audit.read, result: deny, reason_code: missing_permission`,
with a real `request_id` matching that exact call. That's the evidence; the four suites
passing again is necessary but was never going to be sufficient on its own for this one.

## 2026-09-26 · Phase 7 — speed check, and a route-list cross-check

Counted rather than guessed. `grep`'d every `router.(get|post|patch|delete)` registration
across `server/routes/*.js` against `BRIEF.md` §5.1's endpoint table by hand: 33
registered routes, 33 rows in the table, all present. (This is the kind of thing easy to
half-do — implement the routes a test suite happens to exercise and quietly skip the
ones it doesn't, like `GET /orgs/:org/users/:userId/effective` or `DELETE
/orgs/:org/invites/:id`, neither of which `check-api.js` calls directly.)

Timed three requests against a running instance (seed fixture, Acme's 5 devices) rather
than trusting the batched-query design was fast just because it's O(1)-queries-per-list
by construction:

| Request | Time |
|---|---|
| `GET /orgs/org_acme/devices` (5 devices, full resolved permission set per row) | 30ms |
| `GET /auth/me` | 22ms |
| `POST /auth/token` (org switch) | 26ms |

All comfortably inside the "well within a second" bar `BRIEF.md` §6 sets, at a margin
wide enough that I'm not worried about it at seed-fixture scale. I did not test at a
larger device/member count than the fixture provides — the batching argument
(`resolveDevices` issues 3 queries regardless of device count, not one query per row) is
structural, not something I've separately load-tested past the ~5-9 devices the fixture
seeds.

## 2026-09-26 · Phase 6 (cont.) — proving the exclusivity race under real concurrency

`check-api.js`'s `DEVICE_BUSY` test fires two `POST /sessions` calls sequentially
(`await`ed one after the other), which proves the *check* works but not the *race* — a
naive check-then-insert would also pass a sequential test, since there's no window for
two requests to interleave. Fired two genuinely concurrent requests instead
(`Promise.all`, no `await` between them) against a running instance.

First attempt picked the wrong device — `dev_build_server_01` already carries an active
seeded session (`ses_live_build_server`, `usr_sam`, mode `control`), so both new
`terminal` requests got `409` regardless of any race, which told me nothing about
concurrency handling and everything about not checking the fixture state before
choosing a test target. Retried against `dev_kiosk_lobby_01` (no seeded session): result
was exactly one `201` and one `409`, as D10 requires. The partial unique index does what
it's for.

## 2026-09-26 · Phase 6 (cont.) — closing the API gaps `check-api.js` never exercises

Three endpoints `check-api.js` never calls at all: `POST /auth/refresh`,
`DELETE /orgs/:org/members/:userId` (full removal, distinct from the `/suspend` variant
it does test), and `DELETE /sessions/:id` (stop). Verified each directly against a
running instance rather than leaving them as "should work by inspection":

- **`/auth/refresh`**: logged in as Dana to get the httpOnly cookie, called `/auth/refresh`
  with it — `200`, correct role, the new access token works against `/auth/me`.
  Replayed the *same*, now-rotated cookie a second time: `401 UNAUTHENTICATED`, proving
  the reuse-detection/family-revocation path actually fires, not just that it compiles.
- **Member removal**: Dana (owner) removes `usr_acme_viewer` — `200`,
  `{status: 'removed'}`. The removed user's own subsequent login attempt fails, confirming
  `status='removed'` actually blocks access rather than just being a cosmetic flag.
- **Session stop, three shapes**: self-stop → `200`, `end_reason: user_stopped`. Owner
  (holds `session:terminate`) stopping *someone else's* session → `200`,
  `end_reason: admin_terminated`. Sam (operator, no `session:terminate`, not the session
  owner) attempting to stop *Dana's* session → `403 FORBIDDEN`, confirming the "your own
  session OR `session:terminate`" rule is enforced both ways, not just the permissive
  side.

No bugs found in any of the three — but "no bugs found" is only worth something because
each was actually exercised, not assumed from the code reading alone.

## 2026-09-26 · Phase 7 (cont.) — actually clicking through People and Sessions

The last honest gap from the last entry: `PeopleView` and `SessionsView` had never been
driven by anything, test or human — only written against `UI-INVENTORY.md` by
inspection. Wrote a throwaway Playwright script (not committed — `tests/ui.spec.js` is
the real suite; this was a one-off manual check) against a fresh instance and drove it
by hand:

- **People**: sent an invite through the UI form (no crash, form clears); toggled a
  member's role via `role-select`; clicked `suspend-user` on the viewer — button label
  flipped to "Reinstate" — clicked it again, member returned to normal with `Suspend`/
  `Remove` visible again; clicked `remove-user` on a different member — row count went
  5 → 4, confirming the click actually reaches `DELETE /orgs/:org/members/:userId` and
  the view refetches afterward.
- **Sessions**: `new-session` (prompts for device id, then mode) took a session row count
  from 2 → 3; `stop-session` on the newly active row took the active count from 2 → 1.

First run of the sessions check crashed with `dialog.accept: Cannot accept dialog which
is already handled!` — a bug in my *test script* (two separate dialog handlers both
tried to answer the same prompt), not in the app. Fixed by using one handler that
branches on the dialog's message text instead of stacking a `once` and an `on` handler
that raced each other.

Both previously-open UI threads are now closed with real evidence, not just "should work
by inspection."

## 2026-09-26 · Phase 7 (cont.) — load-testing past the fixture scale

The seed fixture only has 5-9 devices per org, which isn't enough to actually see whether
`resolveDevices` is O(1)-queries or secretly O(n). Wrote a throwaway script (not
committed, same reasoning as the manual UI check) that creates a fresh org and scales it
up: 10, 50, 100, 250 devices, scattering a device-scoped grant for roughly 1 in 10, then
timed `GET /orgs/:org/devices` five times at each scale (min/median/max, to filter
first-request noise):

| Devices | min | median | max |
|---|---|---|---|
| 10 | 6.3ms | 7.5ms | 10.7ms |
| 50 | 6.5ms | 14.6ms | 18.7ms |
| 100 | 33.5ms | 48.0ms | 48.6ms |
| 250 | 18.6ms | 48.0ms | 97.1ms |

25x more devices (10 → 250) produced roughly a 6x increase in median latency, not 25x.
That's the actual signature I was looking for: if `resolveDevices` issued one query per
device instead of the fixed ~3 queries it actually runs (membership, role baseline, and
one grants query covering every device at once), 25x more devices would mean roughly 25x
more round trips, not 6x. The residual growth that *does* show up is the in-memory
filtering cost — for every device, every one of the ~20 catalogue permissions gets
matched against however many grant rows exist — which is expected and, at these numbers,
still comfortably under the "well within a second" bar from `BRIEF.md` §6, even at 250
devices. Closes the "performance only measured at fixture scale" open thread below.

## 2026-09-26 · Phase 8 — rigorous adversarial testing

Went looking specifically for concurrency bugs beyond D10 (already proven), since that's
the class of bug a sequential test suite structurally cannot catch. Fired two genuinely
concurrent (`Promise.all`, no `await` between them) `POST /invites/:token/accept` calls
against the same token.

**Expected** it to either work by luck or reveal a real double-accept bug, since
`server/routes/invites.js`'s final `UPDATE invites SET accepted_at = ... WHERE id = ?`
had no `accepted_at IS NULL` guard — a plain check-then-act, the exact pattern
`PERMISSIONS.md` warns against elsewhere. **Observed**: it did not fail — exactly one
`200`, one `409`, one membership row. Traced why before declaring it safe: `better-
sqlite3` is fully synchronous and Node is single-threaded, and nothing in the handler
`await`s any I/O between the read and the write, so the entire accept flow runs as one
uninterruptible block per request — there is no window for two requests to interleave
inside it, even without an explicit guard.

That's real, but it's *incidental* safety — it depends on nobody ever adding an `await`
inside that handler (a slower password hash, an email-verification call, anything
async), not on a schema-level guarantee the way session exclusivity (D10) has one.
**Changed** the final `UPDATE` to `... WHERE id = ? AND accepted_at IS NULL` and check
`result.changes === 0` before returning success — the same "let the database refuse it"
philosophy already applied to sessions, made structural here too instead of leaning on an
implementation detail of the current runtime. Re-ran the concurrent-accept test after the
change: identical result, `200`/`409`, now for a reason that would hold even if the
handler became asynchronous later. `check-api.js`: still 66/66.

Also checked, no bugs found in any:
- **Last-owner protection via full removal**, not just demote/self-leave: `DELETE
  /orgs/:org/members/:userId` on a sole owner → `409 LAST_OWNER`, correctly covering the
  third of the three paths that could zero out an org's owners.
- **Double-revoke**: revoking an already-revoked grant → `404`, matching
  `AUTH-DATA-MODEL.md` §8 ("no longer visible") exactly.
- **Email normalization**: an invite created with `"  MixedCase@Example.TEST  "` is
  stored as `mixedcase@example.test`; the resulting account logs in fine with yet another
  casing (`MIXEDCASE@example.test`).
- **SQL-injection-shaped input**: created an org named literally
  `Robert"); DROP TABLE organizations; --` — stored and returned verbatim as a string,
  table intact, `GET /orgs` unaffected. Parameterized queries throughout hold up under an
  actual attempt, not just by not having written a `string + concatenation` anywhere.
- **Duplicate pending invite** for the same email while one is already outstanding →
  `409 CONFLICT`, as `AUTH-DATA-MODEL.md` §6 requires.

## Open threads

_Things you know are wrong, unfinished, or that you would do differently with another day. Listing
these honestly is worth more than pretending they do not exist — we will find them anyway._

- ~~`POST /auth/refresh`'s default-org selection is untested by any shipped suite~~ —
  closed below (Phase 6, "closing the API gaps `check-api.js` never exercises").
- ~~`PeopleView` and `SessionsView`'s flows were never exercised by any test, server or
  UI~~ — closed below (Phase 7, "actually clicking through People and Sessions"). Not
  added to `tests/ui.spec.js` itself since that file is the graded contract, not a
  scratchpad — the manual script that drove this wasn't committed.
- ~~The exclusive-session race (D10) has only been proven via sequential requests~~ —
  closed, see the Phase 6 concurrency entry below.
- **The org-level vs. device-level resolution judgment call** (argued in `DECISIONS.md`)
  and **the invite role-assignment rank question** (also in `DECISIONS.md`) are both
  reasoned positions, not verified ones — I'd want to see the actual hidden-tier behavior
  before calling either settled.
- ~~Performance was measured only at seed-fixture scale~~ — closed above (Phase 7,
  "load-testing past the fixture scale"): 10 → 250 devices, 25x scale for ~6x latency.
- **The repo itself still contains organizer-only material** (`q1-starter/`, `tools/`,
  `DISCOVERY-RUBRIC.md`, `HARDENING.md`) that leaked through the public fork target. This
  has been flagged to the organizers by email; nothing has been removed pending their
  reply, per an explicit decision to wait for their guidance rather than unilaterally
  restructure the submission.
