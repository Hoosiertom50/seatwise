# Seatwise

Wedding seating & table assignment planner — build a guest list, define who has to (or can't)
sit together, and generate a seating chart that respects every rule.

This repo is the first working slice of Seatwise: account signup/login, creating a wedding,
managing its guest list, defining seating rules between guests, and setting up tables. It's
built to grow into the full feature set described in the requirements doc and tracked in Jira
(TS-2 through TS-15) without a rewrite, and to make an eventual iOS/Android app a thin addition
rather than a second project.

## Stack

- **Next.js (App Router) + TypeScript + Tailwind** for the web app — one codebase, server and
  client, deployed as a single app.
- **PostgreSQL** for the database — see `packages/db/prisma/schema.prisma` for the full data
  model (accounts, weddings, guests, seating rules, tables, plan versions & history, rule
  weighting config). Only the pieces this first slice uses (users, weddings, guests) are wired
  up to the API yet; the rest of the schema is there so later stories are additive.
- **JWT-based auth**, not cookie-only sessions — the web app stores the token in an httpOnly
  cookie, but every `/api/v1/*` endpoint also accepts `Authorization: Bearer <token>`. A future
  mobile app authenticates against the exact same endpoints and stores the token itself; nothing
  about auth needs to change when that app gets built.
- **A REST API under `/api/v1/`** is the only thing either client talks to. The web app happens
  to be Next.js, but the mobile app doesn't need to know that — it just needs an HTTP client and
  a place to keep a token.

## Repo layout

```
apps/web/            Next.js app — pages + /api/v1 route handlers
apps/mobile/          Expo/React Native app (TS-21) — on-site floor-plan view/adjust only, see its
                       own section below
packages/shared/      Zod schemas & shared TS types (validation rules, DTOs) — imported unchanged
                       by both apps/web and apps/mobile
packages/db/           Data model (Prisma schema) + the query layer the API routes use
```

## Getting started (on your own machine)

Prerequisites: Node 20+, pnpm (`corepack enable` will get you the right version), and a
PostgreSQL server (local install, Docker, or a hosted one like Supabase/Neon).

```bash
pnpm install
```

Create `apps/web/.env` (copy `.env.example` at the repo root — it has the full list with
comments):

```
DATABASE_URL="postgresql://user:password@localhost:5432/seatwise_dev?schema=public"
JWT_SECRET="a long random string"
ENCRYPTION_KEY="a different long random string"
# Optional -- leave RESEND_API_KEY unset to use a console-log stand-in for email instead of
# sending real mail (fine for just trying the app out locally).
RESEND_API_KEY=""
RESEND_FROM_EMAIL="Seatwise <notifications@yourdomain.com>"
# Only needs to change if you're not running on localhost:3000 (e.g. deployed somewhere) --
# it's used to build the link in an invite email.
APP_URL="http://localhost:3000"
```

Apply the database schema. On a normal machine, Prisma's CLI will download what it needs on
first run:

```bash
cd packages/db
npx prisma migrate dev
```

Then from the repo root:

```bash
pnpm dev
```

and open http://localhost:3000 — sign up, create a wedding, add some guests, and try the
Seating rules and Tables tabs on a wedding's page. To try collaboration, invite a second account
from the Collaborators tab (the invite link is printed to the terminal running `pnpm dev` if
`RESEND_API_KEY` is unset) and accept it while signed in as that second account.

### Turning on real email delivery

No code is needed for this — the app is already fully wired to send real email through
[Resend](https://resend.com); it's off only because no `RESEND_API_KEY` is set yet. To turn it on:

1. Sign up for a free Resend account at resend.com (their free tier is plenty for trying this out
   — 100 emails/day, 3,000/month at the time of writing).
2. Verify a sending domain or address in Resend's dashboard (Domains → Add Domain, or use the
   sandbox `onboarding@resend.dev` address Resend gives every new account for testing before a
   domain is verified).
3. Create an API key (API Keys → Create API Key).
4. In `apps/web/.env`, set:
   ```
   RESEND_API_KEY="re_..."
   RESEND_FROM_EMAIL="Seatwise <onboarding@resend.dev>"
   ```
   (swap in your verified domain/address once you have one).
5. Restart `pnpm dev` so it picks up the new env vars.

That's it — invite emails, plan-shared notifications, and everything else under FR-10.2 will now
send for real instead of falling back to the console-log stand-in.

### A note on how the database layer was built and verified here

The sandbox this was built in blocks outbound network access to Prisma's binary CDN
(`binaries.prisma.sh`), which `prisma generate` / `prisma migrate dev` need even just to read a
schema — so neither could run inside this environment, full stop, regardless of database
credentials. That's specific to this sandbox, not to Postgres or to your machine; it'll very
likely just work when you run the commands above.

To still build and *verify* a real, running app inside that constraint, the initial schema was
applied by hand: `packages/db/prisma/migrations/0001_init/migration.sql` is a plain SQL file
that matches `schema.prisma` table-for-table, applied directly with `psql`. The API routes talk
to Postgres through the `pg` driver directly (`packages/db/src/queries/*.ts`) rather than through
a generated Prisma Client. The full signup → create wedding → add/edit/remove guest flow was
tested end-to-end against a local Postgres this way, including both the cookie-auth and
Bearer-token auth paths.

`schema.prisma` stays the source of truth for the data model either way. On a fresh database (the
normal case — a new Postgres instance on your machine or elsewhere), `prisma migrate dev` just
applies every migration folder under `packages/db/prisma/migrations/` in order and builds its own
tracking table as it goes — nothing special to do. The "resolve as already applied" caveat only
matters if you ever point Prisma's CLI at *this sandbox's* database specifically, since its first
migration was applied by hand before any tracking table existed there. If you'd rather adopt Prisma
Client for the query layer instead of the current `pg`-based one, that's a reasonable next step
once `prisma generate` can run — the schema and `@prisma/adapter-pg` (already installed) are set
up for it.

## What's implemented

- **Account & Wedding Management** (TS-4 — now fully built, see below): email/password signup and login,
  JWT issued on both, session check endpoint. One account holds any number of weddings
  (FR-1.1), each scoped to its owner with couple's names (via the wedding's own free-text `name`,
  e.g. "Alex & Jordan's Wedding"), optional event date, venue name, and an optional note (FR-1.3).
  Every wedding's guests, rules, tables, plan versions, comments, and activity are fully isolated
  from every other wedding, even under the same owner — cross-wedding access is a 404 in both
  directions (FR-1.2, verified in `test_e2e_isolation.py`). A collaborator's access (added under
  TS-13, below) is re-checked fresh against the database on every request rather than cached, so a
  permission change or revocation is enforced on that user's very next action (FR-1.5), and the
  wedding page itself polls its own access level every 4 seconds so an already-open, idle browser
  tab picks up a change within the same 5-second requirement, without the user taking any action
  (FR-1.6 — see below).
  - **FR-1.3 — the note field**: the one field of the four FR-1.3 names (couple's names, date,
    venue, note) that had never been built. Always optional — creating a wedding with it left
    blank saves with no error, same as before. Set at creation via a toggle-revealed "+ Add a
    note" field on the dashboard's create form (kept out of the way for the common case of not
    needing one), and editable afterwards from the Collaborators tab's owner-only "Note" panel
    (same save-on-blur pattern as the side labels below); a non-owner collaborator, even at Edit
    level, is refused. Verified at the API level (`test_wedding_note.py`) and end-to-end through
    both the create form and the edit panel (`test_wedding_note_ui.py`).
  - **Wedding name, editable after creation**: a planner flagged that there was no way to fix a
    typo in the wedding's own name (e.g. a misspelled name in "Alex & Jordan's Wedding") once it
    was created — the API already supported renaming it (`PATCH /api/v1/weddings/:weddingId`
    already accepted `name`), the UI simply never exposed it. Now editable from the Collaborators
    tab's owner-only "Wedding name" panel, same save-on-blur pattern as the note/side labels here.
    Worth noting explicitly: this app has never had a dedicated "bride's name"/"groom's name"
    field of its own — Bride/Groom only exist as a guest's *Side* (BRIDE/GROOM/BOTH, with
    renameable display labels, see FR-1.3a below); the couple's actual names live only in this one
    free-text wedding-name field, which is what this fix makes editable.
  - **FR-1.3a — per-wedding side labels**: each wedding names its own two sides
    (`sideLabel1`/`sideLabel2`, default "Bride"/"Groom") — set on the Collaborators tab's new
    "Side labels" panel (owner-only), shown everywhere a guest's side is set or displayed (the
    Guests tab's add-guest form, each guest's own Side selector, and the bulk-import column
    mapping label). Renaming is purely a label change: the guest-facing value stored underneath
    (BRIDE/GROOM/BOTH) never changes, so renaming never recreates or touches a guest, rule, or
    seat assignment — verified by renaming mid-test and confirming every guest's id and stored
    side value are byte-for-byte unchanged, and that plan generation (whose Side-Mixing scoring
    only ever reads the underlying value) still works afterward (`test_side_labels.py`).
  - **FR-1.6 — live permission enforcement on an already-open tab**: the wedding detail page
    polls `GET /api/v1/weddings/:weddingId` every 4 seconds (comfortably under the 5-second
    requirement) and compares the returned access level against the last-seen one. A level change
    (e.g. Edit → View) updates the page's state immediately — write controls disappear without a
    reload — and shows a dismissable notice; full revocation (removed as a collaborator entirely)
    shows a blocking full-page message and redirects to the dashboard after a few seconds, rather
    than letting the now-inaccessible tabs fail confusingly against a 404. Verified end-to-end
    with two real browser sessions — one collaborator with the wedding already open and idle,
    the other the owner changing/removing that access out-of-band — confirming both cases land
    well within 5 seconds (`test_live_permission.py`).
  - **FR-1.4/FR-1.4a — Couple-vs-Collaborator role and a real invite lifecycle**: inviting someone
    now sends a real invite (`wedding_invites`: an opaque token, `PENDING`/`ACCEPTED`/`REVOKED`
    status, a 7-day expiry that's derived rather than stored — see `isInviteExpired`-equivalent
    logic in `packages/db/src/queries/invites.ts`) instead of granting access immediately. The
    invite carries a role — Couple or Collaborator, stored on `wedding_collaborators` separately
    from permission level — and no guest data at all: the accept page (`/invites/:token`) shows
    only the wedding's name, role, and level once the invite is confirmed `PENDING` and (once
    someone's signed in) their address matches the invited one; an expired, revoked,
    already-accepted, or mismatched-account invite reveals only that status, never the wedding's
    name. Accepting requires being signed in (or creating an account) with the exact invited
    address — attempting it signed in as anyone else is refused the same way the preview hides
    data. Re-inviting the same address auto-revokes the invite it supersedes, so at most one
    stays active per address. A Couple member's approval authority now follows FR-6.4 for real:
    only the wedding's owner, or a Couple-role collaborator with at least Comment access, can
    Approve a plan — a plain Collaborator, even at Edit level, is refused (closing a simplification
    TS-9's own section below used to call out). The old instant "add an existing account by email"
    endpoint still exists underneath (mainly as fast test scaffolding and a quick-add path) but the
    Collaborators tab's actual "Invite a collaborator" UI now goes through the token flow.
    Full lifecycle (send, list, revoke, re-invite, preview every status, accept, role/approval
    enforcement) verified against the live API in `test_invites.py`, with the Collaborators tab UI
    and the accept page itself driven end-to-end in `test_invites_ui.py`.
  - **Nothing left deliberately out on this ticket anymore** — all three gaps a dev-notes audit
    surfaced (FR-1.3a, FR-1.6, FR-1.4/FR-1.4a) are now closed.
- Add/list/update (RSVP status)/remove guests within a wedding, with tier, party/household
  grouping, headcount, and an accessible-table flag.
- **Bulk guest import & export** (TS-5, FR-2.4/FR-2.4a): the last remaining gap TS-15 surfaced,
  now closed.
  - **Export** (`GET .../guests/export`): every guest as a CSV, including a Guest ID column — the
    only place a planner ever sees one, since IDs aren't shown anywhere else in the UI. It exists
    specifically so a later *update* import has something to map back.
  - **Import preview** (`POST .../guests/import/preview`): given raw CSV text and an explicit
    column mapping (which CSV header corresponds to which guest field — first/last name are the
    only two that must be mapped), classifies every data row as **new**, **updating**, or
    **error** without writing anything. A mapped "Guest ID" column is the *only* way a row targets
    an existing guest (never by name, per FR-2.4a) — an ID that doesn't exist in this wedding, or
    that's referenced by more than one row in the same file, is its own specific row error rather
    than a silent guess. Every other validation failure (bad headcount, an enum value that doesn't
    match Tier/RSVP/Attendance/Side, etc.) is reported with the row number and a specific reason.
  - **Import commit** (`POST .../guests/import/commit`): re-validates from scratch (never trusts
    whatever the client last saw in its preview) and applies as one all-or-nothing transaction —
    if a single row still has an error, nothing is written at all. On an update row, a blank cell
    leaves that guest's existing value alone; a literal `CLEAR` in a nullable text cell
    (Party/household, Notes) explicitly blanks it — a distinction blank-means-unchanged alone
    can't express. No guest is ever deleted by an import.
  - The Guests tab has a matching UI: pick a `.csv` file (headers are read client-side so the
    mapping dropdowns appear immediately), map columns, preview, then confirm — the confirm
    button is disabled while any row still has an error.
  - **FR-2.9 re-check on edit/import** (see its own bullet under Table & Venue Layout below for
    the full explanation): editing a guest's Attendance Status, Side, Relationship Tier, household
    (partyName), or Requires Accessible Table — through this tab's inline controls or a bulk
    import update row — re-checks hard rules and flags **Needs Reassignment** if their current
    seat is no longer valid, or (for Attendance Status specifically) frees their seat outright the
    same way the dedicated Day-of endpoint always has.
  - **Deliberately left out:** Excel (`.xlsx`) isn't parsed, only CSV — spreadsheet software
    exports CSV directly, and adding a binary-format parser for the same acceptance criteria
    wasn't judged worth a new dependency for this pass.
  - **Inline guest name editing**: a planner flagged that there was no way to fix a misspelled
    guest's first/last name short of a full CSV re-import (matching by Guest ID) or deleting and
    re-adding the guest — the API and DB already accepted a name change on update
    (`PATCH /api/v1/weddings/:weddingId/guests/:guestId`), the Guests tab simply never exposed an
    edit control for it. Each guest's name is now two small inline text fields (first/last),
    save-on-blur, the same per-field optimistic-update-then-reconcile pattern as every other
    inline guest edit here (Side, RSVP status, email). This also retires the "a future full edit
    form" phrasing the FR-2.9 bullet below used to have — the inline controls are the edit form
    now, name included.
- Seating rules between guests (must sit together / must not sit together / prefer near / avoid),
  with the FR-0.1 hard-rule invariant enforced server-side: a pair of guests can't simultaneously
  be required to sit together and forbidden from it — that's blocked outright with a clear error,
  not just left to the UI to prevent.
  - **Cross-cutting hard-rule invariant** (TS-3, FR-0.2 AC2): the flip side of FR-0.1 above — an
    action that would leave a *soft* rule (Prefer Near/Avoid, or a table's Single-Side-Only flag)
    unsatisfied always still saves, with a visible, non-blocking warning, never a blocking error.
    That much already existed at every site that produces one of these warnings (a manual move, a
    day-of swap, generation itself). The real, previously-flagged gap was narrower than "does the
    warning exist" — FR-0.2 AC2 also requires the warning to name "the applied
    weighting-configuration version," and none of the three warning strings did; they named the
    guests and the rule, but not the version. Every soft-rule warning site now appends "(weighting-
    configuration version N)" using the same `RULE_WEIGHT_CONFIG_VERSION`/`ruleConfigVersion`
    already stored on each plan version (see the Side-Mixing/`ruleConfigVersion` bullet under
    Relationships & Seating Rules gap-closing, TS-6/FR-3.4, below) — verified end-to-end for the
    manual-move, swap, and generation warning paths in `test_warning_rule_config_version.py`.
- **Table & Venue Layout** (TS-7, FR-4.1–FR-4.7): create/update/delete tables for a wedding with a
  name, seat capacity, optional purpose (e.g. "Kids table"), a restricted flag, and an
  accessible-seating flag, plus:
  - **Shape** (FR-4.1): Round, Rectangular, Square, Oval, or Other — affects only how the floor
    plan (below) draws the table; changing it never touches generated assignments or rule
    results.
  - **Quick-create a standard set** (FR-4.2): "12 round tables of 8" in one action
    (`POST .../tables/quick-create`) — every table gets a distinct name, numbered to continue
    after any tables that already exist so a repeated quick-create never collides with an
    earlier one.
  - **Optional visual floor plan** (FR-4.3): a "Floor plan" view (alongside the original list
    view) on the Tables tab where each table can be dragged into position. Every table gets a
    sensible default grid position the moment it's created — dragging just moves it from there —
    and the position is saved purely for display; it's never read by the seating engine,
    generation, Prefer-Near/Avoid, or tier grouping in any way, confirmed by generating a plan,
    moving a table, and regenerating: the assignments are byte-for-byte identical either way.
  - **Capacity enforcement** (FR-4.4): unchanged from the engine and manual-move behavior
    described below — a table is never overbooked, whether by automated generation or a manual
    edit.
  - **Capacity overview** (FR-4.5): the Tables tab shows Attending guest count, total capacity,
    assigned count, and remaining capacity at a glance, excluding Not Attending guests from the
    count entirely; when guests exceed capacity, the exact shortfall is called out.
  - **Accessible-flag re-check** (FR-4.6): unmarking a table Accessible re-checks FR-0.1 for
    anyone currently seated there who requires one — they're flagged **Needs Reassignment**
    (the `needsReassignment` field on a plan version's assignments) and the current plan version
    is marked incomplete until it's fixed, rather than silently leaving them in a now-invalid seat.
    Re-marking the table Accessible again clears the flag and restores completeness (as long as
    nothing else is wrong). With no affected guest, the flag toggles freely either way — no
    warning, no incompleteness. The Plan tab now shows a "needs reassignment" badge next to any
    flagged guest's name, wherever this pass's more general FR-2.9 re-check (below) or this
    table-side one sets it.
  - **FR-2.9 (generalized): editing or importing a change to a guest's Attendance Status, Side,
    Relationship Tier, household, or Requires Accessible Table re-checks their current seat
    assignment against hard rules.** This generalizes FR-4.6 above beyond its one original
    trigger (a table's Accessible flag) to the *guest* side: `PATCH .../guests/:id` and a bulk
    import's update rows both now run the same re-check.
    - **Attendance Status → Not Attending** gets FR-8.1's full existing behavior (the seat is
      freed immediately and the guest is excluded from completeness, not just flagged) rather than
      a new, separate "flagged" state — reusing `setGuestAttendance` under the hood. This closes a
      real gap: editing `dayOfAttendance` through the general guest-edit endpoint or an import
      previously changed the column directly without freeing the guest's seat at all, unlike the
      dedicated Day-of-mode endpoint. That stale-assignment gap is what `test_version_compare.py`
      was unknowingly relying on to construct one of its own test scenarios — fixing FR-2.9
      surfaced it, and the test was rewritten (generate the older version *before* the attendance
      change, matching how Plan Versions are actually meant to behave) rather than worked around.
    - **Side, Relationship Tier, household (partyName), and Requires Accessible Table** re-check
      the guest's current table against every hard rule a guest-level edit can actually affect:
      Requires Accessible Table vs. the table's Accessible flag, a Restricted table's
      required-guest list, and Must-Not-Sit-Together against whoever else is seated there —
      flagging **Needs Reassignment** (and marking the plan incomplete) if any is now violated, or
      clearing the flag if it's no longer violated. Side-Mixing and a table's `singleSideOnly`
      override are explicitly soft-only preferences in the engine (never a hard rule), so a side
      change alone won't trip this today — the re-check still runs for every named field
      (consistent, and correct if a future hard rule ever keys off side/tier/household), it's just
      an honest "nothing's actually wrong" for those specific fields under today's rule set.
    - **Removing a guest** also recomputes the current plan's completeness — deleting a guest
      cascades away their own seat assignment at the database level regardless, but if they were
      counted as Unassigned, removing them can flip an incomplete plan back to complete, which
      nothing previously recomputed.
    - **Deliberately out of scope:** FR-2.9 also names "age category" and "identity" as triggers.
      Age category was never built anywhere in this app (a pre-existing FR-2.2 gap, not something
      this pass introduced or could reasonably backfill as a side effect), so there's no field to
      re-check. A guest's own name/identity changing has no hard-rule implication (nobody's seat
      becomes invalid because their name changed), so there's genuinely nothing to re-check there
      either.
  - **Table-level assignment only** (FR-4.7): confirmed by inspection across every planning,
    review, day-of, and export interface — there's no chair/seat-position concept anywhere in the
    schema, API, or UI; "available seat" always means available table capacity.
- **Automated seat assignment engine** (TS-8): a "Generate new plan" button on a wedding's
  Seating plan tab groups guests into tables, respecting every hard rule and never silently
  breaking one:
  - Guests forced together by "must sit together" (including chains — if A must sit with B, and
    B must sit with C, all three are kept together as one unit) always land at the same table.
  - Guests with a "must not sit together" rule are never placed at the same table as each
    other — whether or not they're in the same forced-together unit — and a rule that's flatly
    unsatisfiable (e.g. A-B and B-C are forced together, but A-C also must not sit together) is
    rejected outright before anything is saved, with a clear explanation of the conflict.
  - A guest who needs an accessible table is only ever placed at one flagged as accessible.
  - Table capacity is a hard limit — a table is never overbooked.
  - "Prefer near" / "avoid" are treated as soft, best-effort preferences: honored when there's
    room to do so, and surfaced as a non-blocking warning (naming the guests involved, and the
    weighting-configuration version in effect — see the TS-3/FR-0.2 bullet above) when they can't
    be.
  - If there isn't a valid seat for everyone (not enough capacity, or every remaining table
    already seats someone a guest must not sit with), the plan is generated anyway, those guests
    are listed as unassigned with a clear reason, and the plan is marked incomplete — nothing is
    ever guessed or silently dropped.
  - Every generation creates a new numbered version; past versions stay viewable from the
    dropdown on the Seating plan tab.
  - Restricted tables with a required-guest list (FR-3.7a, closed as part of the TS-6 gap-closing
    pass below) *are* seated automatically: every listed guest is pinned to that table at
    generation time, the same way a locked guest is pinned to theirs, with the same
    graceful-fallback-with-warning behavior if the pin can no longer be honored.
  - **Soft-preference score report** (FR-5.3): the response from a generation also carries a
    `scoreReport` — the weighting-configuration version used, a total score, every individual
    Prefer Near/Avoid relationship's satisfied/unsatisfied outcome (by name, not just a count),
    each Purpose table's wedding-wide match rate, and a Side-Mixing aggregate (mixed vs.
    single-side table counts, and any Single-Side-Only violations). The Plan tab shows this
    alongside the generated plan, with a "How is this calculated?" toggle that displays the exact
    `RULE_WEIGHT_CONFIG` weights the version number refers to — the point of FR-5.3's "any
    displayed score links to its calculation method," not just a number with nothing behind it.
    Deliberately transient like `warnings` already was: it's computed by the pure engine function
    and returned only in that immediate response, never persisted — regenerating recomputes it
    fresh rather than reading back something stale. Verified in
    `test_score_report_and_comparison_draft.py`.
  - **Make Current vs. Save as Comparison Draft** (FR-5.6): generating now asks upfront (a
    checkbox on the Plan tab, `makeCurrent` in the API) whether this run becomes the new Current
    version — replacing whichever was Current before — or a non-replacing Comparison Draft that
    exists purely to be looked at and compared, never touching what the wedding actually uses.
    This required turning `isCurrent` from something that used to be *computed* (whichever version
    had the highest number was, by definition, "current") into its own independently-settable
    column, enforced to at-most-one-true-per-wedding by a database-level partial unique index —
    so a draft can legitimately have a higher version number than Current without ever becoming
    it. A hard-rule contradiction still produces only a conflict report and saves nothing, for
    either choice (FR-5.6 AC6's last clause) — that part needed no new code, since a rejected
    generation already never reached the point of creating a version at all. Verified in
    `test_score_report_and_comparison_draft.py`.
    - **A real regression this surfaced, and fixed as part of the same change:** every place that
      used to read "the first (highest-numbered) plan version" as shorthand for "Current" —
      Day-of Mode, the Tables tab's capacity overview, the Plan tab's own initial load, and the
      mobile app's on-site floor plan screen — stopped being safe the moment a Comparison Draft
      could outnumber Current without replacing it. All four now select by `isCurrent` explicitly
      instead (falling back to the first row only when the list is otherwise empty), so a
      Comparison Draft never gets mistaken for the plan actually in effect — confirmed in
      `test_current_vs_draft_selection.py`, which checks the exact shape (`isCurrent` present per
      row, and NOT always on the first row) those call sites now depend on.
- **Plan review status** (TS-9 — now fully built, see below): the Current Plan Version (the one
  explicitly marked `isCurrent` — see FR-5.6 under Automated seat assignment engine above; before
  that, always just whichever version had the highest number) moves through Draft → In Review →
  Approved. Approving requires a complete plan
  (FR-0.1) and only ever applies to the current version — an older, superseded version's status
  can no longer be changed. Approving is a checkpoint, not a lock: nothing about assignments,
  rules, guests, or tables becomes read-only. If the plan is edited after approval, it stays
  Approved but shows a "Modified since approval" indicator (first/latest change time); moving
  status back to Draft or In Review clears that indicator without deleting the underlying
  history. Every status change is recorded as an immutable Change History entry (user,
  timestamp, from → to).
  - **FR-6.1**: the Seating plan tab (both List and Floor plan views) never shows a guest nested
    inside a table's guest list unless that placement genuinely respects every current hard rule.
    Unassigned guests have always had their own "Unassigned" area; a seated guest whose table no
    longer fits a hard rule for them (e.g. a field was edited, or a table's Accessible flag was
    turned off after they were seated there) is now pulled out of that table's box the same way —
    into its own amber "Needs reassignment" area (with a "currently at {table}" note and a "Move
    to..." control filtered to exclude that same table) — rather than staying listed inside the
    now-invalid table with just a badge, which would still read as a placement the plan considers
    valid. A guest marked Not Attending (FR-8.1/TS-11) is excluded entirely rather than shown as
    unassigned or needing reassignment, since they were never a seat to fill. Verified with
    `test_plan_reassignment_ui.py`, a two-view Playwright check confirming the guest appears only
    in the separate area, never inside their old table's list, in both views.
- **Manual adjustment** (TS-10, partial — see below): on the Seating plan tab, every seated and
  unassigned guest gets a "Move to.../Seat at..." control to manually place them at a different
  table within the Current Plan Version, without generating a new version:
  - **FR-7.1**: the Seating plan tab has its own "List / Floor plan" toggle, mirroring the Tables
    tab's. Its floor plan reuses each table's saved room position (so both tabs agree on the
    layout) and shows every seated guest as a small chip inside their table's box, plus an
    "Unassigned" dock above the canvas. Dragging a guest chip onto a different table box moves
    them — dragging one onto their own table is a no-op, and dragging an unassigned guest onto a
    table seats them. This calls the exact same move endpoint the "Move to..." dropdown uses, so
    every rule below (hard-rule blocking, soft-rule warnings, must-sit-together groups moving
    together, locks, Change History) applies identically whichever UI made the move — dragging
    is a second way to trigger the same validated action, not a second code path. Disabled the
    same way the dropdowns are: view-only for a past version, and turned off entirely for a
    Comment/View-level collaborator (the chips simply aren't draggable).
  - **FR-7.5**: Undo/Redo buttons appear on the Seating plan tab once this browser session has
    made at least one manual move. Undo replays the inverse of the session's most recent move —
    back to the guest's actual prior table, or back to Unassigned if that's genuinely where they
    started — by re-checking the plan first and re-running the same validated move-or-unassign
    call, so it's subject to the exact same hard-rule checks a fresh move would be (FR-7.2 still
    applies to an undo). Redo re-applies whatever was just undone. Both are strictly
    session-scoped, in-memory state — switching plan versions, generating a new version,
    restoring one, or reloading the page all clear the history, matching the requirement that a
    reload falls back to version history instead. Before replaying either one, the guest's
    current seat is checked against what this action expects to find — if anyone (this session
    via another tab, or another collaborator) has since moved that guest again, the stale
    undo/redo entry is dropped with an on-screen explanation instead of silently overwriting
    that newer change. Undoing an "assign a previously-unassigned guest" move needed a genuine
    new primitive — putting a guest back to Unassigned — since nothing in the app could do that
    before; the assignment endpoint now accepts `tableId: null` for exactly this (never exposed
    as its own "Unassign" button, only used by undo/redo today), which itself takes the same
    must-sit-together unit the forward move would.
  - **FR-7.7** (originally scoped to the Current Plan Version, since extended — see below): every
    write that touches the Current Plan Version's assignments, status, or label (move, unassign,
    swap, status change, relabel) carries a `revision` counter. A client sends back the revision it
    last loaded; if someone else's save has moved it on, the write is rejected outright — with a
    409 and the fresh, currently-committed plan version attached — instead of silently overwriting
    what they just did. The rejected user sees "This plan changed since you loaded it — someone
    else's change landed first," the view refreshes to the real state automatically (no page
    reload), and their own attempted change is simply not applied, so they can look at what's there
    now and retry deliberately. Separately, the Seating plan tab polls for a newer revision every 4
    seconds while a Current Plan Version is open (paused while a move/undo/redo/status/label save
    of your own is in flight, so it can't race your own write) and merges in whatever a
    collaborator has since saved — meeting the "visible within five seconds without a manual
    refresh" requirement without needing websocket/SSE infrastructure. `expectedRevision` is
    optional on every one of these endpoints, so this is purely additive: a caller that omits it
    gets the exact old behavior. Guests and seating tables now carry the same `revision` counter
    and `expectedRevision` contract on their own edit endpoints (see the TS-10 paragraph below) —
    editing a guest's tier, side, or lock, or a table's lock/accessible/single-side/position, is
    protected exactly the same way.
  - Guests forced together by "must sit together" always move as one unit — moving one member
    brings the rest along automatically.
  - A move that would break a hard rule (capacity, must-not-sit-together with whoever's already
    at the target table, or requires-accessible-table) is rejected outright with a specific,
    named explanation, and nothing changes (FR-7.2) — verified for all three cases.
  - A move that only conflicts with a soft "avoid" preference is allowed and comes back with a
    visible, non-blocking warning naming who's affected (FR-7.3).
  - Unlike automatic generation, a manual move can target a restricted table — that's the point
    of "manual assignment" for those tables.
  - Every successful move is recorded as an immutable Change History entry (user, timestamp,
    guests, table) without creating a new plan version (FR-7.6).
  - A guest or table can be locked (FR-7.4): a locked guest keeps their current table the next
    time a plan is generated instead of being reshuffled, and a locked table is reserved —
    generation won't seat new guests there. Locks are visible (a "locked" badge on the Guests
    and Tables tabs) and never affect manual moves or hard-rule checks. If a lock can no longer
    be honored (its table was deleted, or keeping it would now break a hard rule), the guest
    falls back to normal automatic placement with a warning explaining why, rather than being
    stranded over a stale pin.
- **Day-of / Emergency Mode** (TS-11, FR-8.1–FR-8.4): a dedicated "Day-of mode" tab, built for a
  phone in someone's hand at the venue rather than a laptop at a desk:
  - A guest's same-day **attendance** (Attending / Not Attending) is tracked completely separately
    from their `rsvpStatus` — someone can RSVP Confirmed weeks out and still no-show, or walk in
    unannounced. Marking a guest Not Attending frees their seat **immediately**, with no full plan
    regeneration and nobody else's seat moving, and excludes them from the unassigned/completeness
    count entirely (they're not "pending" — they're not here today). Reverting them back to
    Attending does *not* auto-seat them; per FR-8.1 they come back as Unassigned until someone
    explicitly (re)seats them, since their old table may no longer have room or be the right call.
  - A **walk-in** guest can be added and seated in one flow — it's the existing create-guest and
    manual-move endpoints, so it gets exactly the same hard-rule validation (a walk-in can't be
    seated at a table that's already full, requires-accessible-table conflicts, etc. — rejected
    with the same specific, named reason a planned move would get).
  - Two guests' (or their forced-together units') tables can be **swapped** in one atomic action —
    "put the Smiths where the Johnsons were, and vice versa" — instead of the two-step dance of
    moving one to a holding spot first. Both directions are validated against every hard rule
    (capacity, accessible-table, must-not-sit-together) *before* anything changes; if either
    direction would break one, the whole swap is blocked with a specific explanation and nothing
    changes. An "avoid" conflict in either direction is allowed but comes back as a non-blocking
    warning, same as a regular manual move.
  - The tab itself: a search box to find a guest fast, an at-a-glance table-occupancy summary
    (seated/capacity per table), and every actionable control sized to ~44×44 CSS px (FR-8.4) —
    verified visually at a 390×844 (phone-portrait) viewport as well as desktop width.
  - Generating a brand-new plan now excludes Not Attending guests entirely — not just from
    seating, but from the relationship graph too (a "must sit together" rule involving someone
    who isn't here today simply doesn't apply while they're out).
  - Every attendance change and swap is recorded as its own immutable Change History entry (actor,
    timestamp, description), same as a regular manual move.
- **Export & Print, and version restore** (TS-12, FR-9.1–FR-9.4): available once a plan version is
  Approved (exporting a plan that could still change under you doesn't make sense, so this is
  gated the same way the acceptance criteria describe it):
  - **Seating chart PDF** (FR-9.1): every table, guest names underneath, paginated automatically
    for large weddings.
  - **Guest lookup list PDF** (FR-9.2): every guest alphabetically (last name, then first — the
    same order the rest of the app uses for a guest list) with their table, for whoever's on
    door/registration duty.
  - **Place cards PDF** (FR-9.3): one print-ready card per guest (name + table, cut lines), several
    to a page.
  - All three are generated server-side with `pdf-lib` (no headless browser, no external
    service) from the same `(guestName, tableLabel)` data every plan-version endpoint already
    returns.
  - **Restoring a prior version** (FR-9.4): Plan Versions and Change History are kept genuinely
    distinct — restoring v2 never rewrites v2, v3, v4, v5, or any of their history; it creates a
    brand-new version (v6) that copies v2's assignments and becomes Current simply because it's
    the newest version. Since guests/tables/rules can have changed since v2 was made, every one of
    its assignments is re-validated against *today's* data before being copied (FR-0.1): a table
    that's gone, shrunk below what it now holds, lost its accessible flag, or a "must not sit
    together" rule added since then all drop the affected guest back to Unassigned with a specific
    reason rather than silently keeping something no longer valid. A `GET .../restore-preview`
    endpoint computes exactly this (kept vs. dropped, with reasons) without writing anything, so
    the UI can show what a restore would do and let the user confirm before `POST .../restore`
    actually commits it — a "must sit together" rule added since the snapshot is a genuine tension
    with "restore exactly what v2 looked like," so rather than silently reshuffling the copied
    layout to fix it, that case is surfaced as a non-blocking warning instead.
  - **Version labeling and comparison** (TS-10/TS-12 follow-on): any version — current or past —
    can be given a free-text nickname (`PATCH .../plan-versions/:id` with `{ label }`; a blank
    string clears it back to none) so it's easier to tell apart than just its version number; the
    version picker on the Seating plan tab shows the label alongside the number. A
    `GET .../plan-versions/compare?from=:id&to=:id` endpoint diffs any two versions guest by guest
    — each guest is reported `unchanged`, `moved` (seated at a different table in each), `added`,
    or `removed` (seated in only one of the two, e.g. their attendance changed between versions) —
    with a summary count of each. The Seating plan tab has a "Compare two versions..." panel that
    picks any two versions from the wedding's history (not just the current one against a past
    one) and renders the diff as a table.
- **Collaboration & Notifications** (TS-13, FR-10.1–FR-10.3): a real multi-user model on top of
  the single-owner one every earlier story used.
  - A wedding's owner can invite any other existing Seatwise account by email at **View**,
    **Comment**, or **Edit** access (each level includes everything below it; the owner is
    implicitly above Edit and never has their own row in the collaborator table). Every existing
    endpoint — guests, tables, rules, plan versions, manual moves, day-of mode, export, restore —
    now checks this access level instead of pure ownership: reads need View, writes need Edit;
    renaming/deleting the wedding and managing collaborators stay owner-only.
  - **Permission-aware UI** (follow-on to the above): every tab (Guests, Seating rules, Tables,
    Seating plan, Day-of mode, Collaborators) now hides or omits a write control a View/Comment-
    level collaborator can't use, rather than showing it and letting the server's already-correct
    403 be the first sign something's off. A View-only collaborator sees a plain "view-only access"
    note in place of the add/import/edit forms per tab, read-only status text instead of action
    buttons on each row, and the floor plan's tables stop being draggable; an Edit-level
    collaborator (or the owner) sees every control exactly as before. This is UI-only — the
    server-side access checks it mirrors were already there and unchanged.
  - **Comments** (FR-10.3) attach to a specific guest or table, support one level of threaded
    replies, and can be resolved by the original commenter or anyone with Edit access (nobody
    else). A comment's target label (e.g. "Guest: Jane Doe") is captured once at creation, so if
    that guest or table is later renamed or removed, the comment stays understandable instead of
    silently losing its context or breaking — it's just shown as historical ("removed").
  - **Activity log** (FR-10.1): a single chronological feed across *every* plan version of a
    wedding (every earlier story's Change History entries were only ever queryable one version at
    a time) — status changes, manual moves/swaps, attendance changes, and restores, newest first,
    each with who did it and when.
  - **In-app and real email notifications** (FR-10.2): the owner and every other collaborator
    (except whoever caused it) gets a notification when a plan is shared for review, a comment
    gets a reply, or — once the Current version is Approved — a guest's table changes, a guest is
    added or removed, or attendance changes; any other status transition also notifies. A bell in
    the header (every page) shows the unread count and a dropdown to read/mark-read. Each wedding
    has a per-wedding email opt-out (on by default). Email delivery goes through Resend; this
    sandbox has no real Resend account, so `RESEND_API_KEY` is an env-var placeholder (see
    `.env.example`) and, unset, falls back to logging what would have been sent — set the key (and
    `RESEND_FROM_EMAIL`, a verified sending address in that Resend account) to send real email
    with no other code change. Either way, a failed or unconfigured send can never block the
    in-app notification or the action that triggered it — verified end-to-end against a live
    (restarted) server both with no key configured and with a key Resend actually rejects, in
    both cases confirming the underlying action still succeeds and the in-app notification still
    lands, and that a real rejection is genuinely logged rather than silently swallowed
    (`test_email_provider.py`).
- Every list/detail endpoint enforces access — you can't read or modify a wedding, guests, rules,
  tables, or plan versions you don't own or collaborate on by guessing an ID, and a seating rule
  can't be created between guests from two different weddings even if you have access to both.
- **Non-Functional Requirements** (TS-14): performance, security, availability, and accessibility
  verified and, where needed, built out across the whole app rather than any one feature.
  - **Performance** (NFR-9.1/9.1b): a 500-guest wedding with 55 tables and 50 seating rules
    generates a full plan in well under a second (0.34s measured, against a 60s target), and a
    single manual move/swap round-trips in 0.065s (against a 1s target) — both scripted end-to-end
    against the real API and database, not estimated.
  - **Plain-language UI and specific error messages** (NFR-9.2/9.2b): every blocked action across
    the seating engine, manual moves, and swaps already names the specific rule, guest(s), and
    table involved rather than a generic "can't do that" — e.g. `"Jane Doe has a "must not sit
    together" rule with John Smith, who's already seated at "Table 3.""` for a rule conflict, or
    `""Table 3" can't fit Jane Doe's group — it only has 2 seat(s) left, but they need 4."` for a
    capacity conflict. This was existing behavior from TS-6/TS-10; TS-14 confirmed it holds for
    every blocking path (capacity, accessibility, hard rules, both directions of a swap) rather
    than adding new messages.
  - **Access control** (NFR-9.3): already fully covered by TS-13's access-level model and its
    `test_collaboration.py` regression — a stranger gets a 404 (not a 403, so a nonexistent and an
    inaccessible wedding are indistinguishable) on every endpoint for a wedding they don't own or
    collaborate on, confirmed by direct ID guessing, not just missing UI links.
  - **Encryption at rest** (NFR-9.3b): guest `notes` — the field free-text dietary and
    accessibility information lives in — is encrypted with AES-256-GCM before it's written to
    Postgres and decrypted only when read back out for an authorized request. Verified by querying
    the raw database row directly (bypassing the API entirely) and confirming the stored value is
    ciphertext (`enc:v1:...`), not the plaintext that was submitted. Deliberately scoped to this
    one field rather than the whole database: it's the specific personal/health-adjacent data the
    requirement is about, and column-level encryption keeps every other field queryable/sortable
    normally. Encryption in transit (TLS) and whole-database encryption/backups are hosting-level
    concerns (what terminates HTTPS, what the managed Postgres provider encrypts at rest) that
    don't exist as "application code" to write in this sandboxed dev environment — they're
    configuration of wherever this gets deployed, not a gap in the app.
  - **Accessibility** (NFR-9.5): every page and wedding tab (login, signup, dashboard, Guests,
    Rules, Tables, Seating plan, Day-of mode, Comments, Activity, Collaborators) scanned with
    axe-core against the WCAG 2.1 A/AA and 2.1 A/AA rule sets. The initial scan found unlabeled
    inputs/selects (missing `label`/`aria-label`) on 9 of those views and one contrast failure;
    all were fixed (explicit `<label htmlFor>`/`id` pairs, `aria-label` on selects that don't have
    a visible label, `sr-only` labels for the Day-of walk-in fields, `text-neutral-400` swapped for
    the AA-passing `text-neutral-500`) and every page re-scanned clean — **zero violations**
    across all 11 views. The Seating plan view's controls were also brought up to the 44×44px
    touch-target size Day-of Mode already used (`min-h-11`), matching the acceptance criterion
    that names both views explicitly. No element in the app overrides the browser's default
    focus-visible outline, so keyboard-only operation keeps visible focus everywhere.
  - **Responsive, no horizontal scroll** (NFR-9.5b): checked programmatically (comparing
    `scrollWidth` to `clientWidth`) across 6 widths (375/390/768/1024/1280/1920px) on all 8 wedding
    tabs — 48 checks, zero overflow anywhere — plus a manual tablet-viewport (768×1024) pass over
    the dashboard, Guests tab, and Day-of mode. Day-of Mode was already optimized for a portrait
    phone as part of TS-11.
  - **Availability** (NFR-9.4): exported PDFs (place cards, table signs, seating charts — from
    TS-12) are static files with no external network calls baked in, so they're fully usable
    offline once downloaded/printed, satisfying the "event-ready exports work without a live
    connection" half of this requirement directly. Uptime monitoring and planned-maintenance
    scheduling are hosting/ops concerns with nothing to build in application code in this
    environment — scoped out the same way TLS and infrastructure-level encryption are above.
- **Integration / End-to-End Scenarios** (TS-15): TS-15 has no requirements of its own — it
  validates that every feature-area story above actually works together across a full planner
  workflow, so this pass added no new application code, only two new end-to-end test scripts
  exercising the live API/database as a single continuous story:
  - A new wedding is built up (~100 guests, must-sit/must-not-sit/prefer-near/avoid rules, 10
    quick-created tables), generated (fully seated, hard rules genuinely honored), shared (Draft →
    In Review), has a blocked edit explained (a specific, named error, nothing changed), and is
    approved by an invited Edit-level ("Couple") collaborator rather than the owner — ending
    Approved, fully seated, with no unresolved issues.
  - On that Approved plan: 2 guests marked Not Attending and 1 late guest manually seated all land
    on the *same* plan version (no full regeneration), the plan stays Approved with the "Modified
    Since Approval" indicator now active (first/latest timestamps), and all 3 changes appear in the
    Activity log.
  - A no-show is marked and two guests are swapped in day-of mode — a swap that would violate a
    hard rule is blocked exactly like a regular manual move, a valid one succeeds, and both are
    recorded in Activity — while re-exporting the seating chart PDF afterward produces different
    bytes than one exported before the changes, demonstrating an export is a snapshot at
    generation time rather than something that updates itself after the fact.
  - Two weddings owned by the same planner, each independently built, generated, and approved by
    its *own* distinct collaborator, are confirmed to share no data whatsoever: cross-wedding
    access is a 404 in both directions, a guest/table ID from one is meaningless under the other's
    endpoints, a seating rule can't be created across them, a manual move can't reference the
    other's guest or table, and each wedding's Activity log and comments never mention the other's
    guests.
  - **Scope note:** the acceptance criteria as originally written mention two things this codebase
    didn't have at the time — bulk CSV/Excel guest import (FR-2.4/2.4a, a TS-5 gap) and a
    wedding-level Side-Mixing setting (FR-3.4, a TS-6 gap, closed below). Neither existed anywhere
    in the schema or API at the time (confirmed by inspection, not assumed), so rather than fake
    them, the end-to-end script stood in for "import a spreadsheet" by adding guests through the
    existing create-guest endpoint (the same end state — 100 guest records in the wedding) and
    skipped Side-Mixing entirely. Every other piece of every acceptance criterion was exercised for
    real. (Both gaps — bulk guest import, FR-2.4/2.4a, and Side-Mixing, FR-3.4 — have since been
    closed; see the bulk-import bullet near the top of this list and the TS-6 bullet just below.)
- **Relationships & Seating Rules gap-closing** (TS-6, FR-3.4 and FR-3.7a): TS-15's own testing
  surfaced two acceptance-criteria gaps in TS-6 (see the scope note just above); this pass closes
  the two of them that were in scope for TS-6 itself.
  - **Side-Mixing setting** (FR-3.4): a per-wedding `sideMixing` setting — Keep Separate, Balanced
    Mix (the default), or Fully Mixed — controls how strongly automatic generation favors or avoids
    seating Bride-side and Groom-side guests at the same table. Every guest has a `side` (Bride /
    Groom / Both — "Both" never counts toward either side, e.g. a mutual friend or a couple already
    in the family). It's always a *soft* preference, never a hard rule: Keep Separate penalizes an
    opposite-side guest at the same table in the scoring function, Fully Mixed rewards it (and
    lightly penalizes same-side clustering), Balanced Mix rewards it more mildly. A table can
    independently be marked `singleSideOnly`, a soft override that prefers keeping whichever side
    is already established there, regardless of the wedding's own setting. Every generated plan
    version records the exact `sideMixingSetting` and a `ruleConfigVersion` (a versioned snapshot of
    the scoring weights used, persisted alongside it) it was generated under, per FR-3.4's
    acceptance criterion that this be auditable after the fact — not just applied silently.
  - **Restricted table required-guest list** (FR-3.7a): a Restricted table can now be given an
    explicit required-guest list (`PUT .../tables/:tableId/required-guests`) — the guests who *must*
    sit there (e.g. the reserved family table mentioned in the FR-3.7a acceptance criteria). A
    guest can be required at only one Restricted table wedding-wide, enforced at the database level
    (not just in application code), and the list is validated and saved atomically: an
    over-capacity list, an unknown guest, or a guest already required at a different Restricted
    table is rejected outright with a specific reason, and nothing is saved. At generation time,
    every listed guest is a hard pin to their table (reusing the same pinned-placement machinery
    locked guests already use, with a fallback-with-warning if a pin can no longer be honored — see
    the earlier note under "Automated seat assignment engine"). Manual moves and swaps respect the
    list going forward too: a listed guest can't be manually moved off their required table, an
    unlisted guest can't be manually moved onto a Restricted table, and a swap is blocked outright
    if either table involved is Restricted (a scope-limiting simplification — partial-list
    consistency during a swap was judged not worth the added complexity for this pass).
  - **Purpose table structured criteria** (FR-3.7): a table's free-text `purpose` label (e.g.
    "Kids' Table") now has an optional structured criterion alongside it — Side, Relationship Tier,
    or Age Category — that generation treats as its own soft-preference scoring input, the same way
    Side-Mixing and single-side-only already are: a matching guest is favored for that table, a
    non-matching guest is mildly disfavored (never blocked), and overflow beyond the table's
    capacity is placed elsewhere without ever failing generation on that account alone. A brand-new
    `ageCategory` field (Adult / Child / Infant, defaulting to Adult) was added to guests for the Age
    Category criterion to match against — set from the guest form or bulk CSV import, same as Side
    and Relationship Tier. Finding the right balance took an extra iteration: an early version scored
    only a bonus for a match, and testing (a 4-children-vs-2-seat "Kids' Table" scenario, matching
    the FR-3.7 acceptance criteria) caught that with no penalty for a mismatch, the engine's existing
    leftover-capacity tie-break could still steer non-matching guests into the small criterion table
    ahead of the guests it was actually meant for; a small mismatch penalty (a third of the match
    bonus) fixed it without turning the preference into a hard rule. Also fixed alongside this: the
    pre-existing `singleSideOnly` table flag (FR-3.4) was fully built in the engine, schema, and API
    but had no control anywhere in the Tables tab — it was only ever settable by calling the API
    directly. It's now a checkbox on the create-table form and on every existing table's row, with a
    badge reflecting its state, matching how every other table flag already works.

- **Dark mode**: the app now follows the OS/browser color-scheme preference instead of being
  pinned to light mode. The earlier light-only pin (`color-scheme: light` in `globals.css`) was a
  stopgap after every component turned out to be styled with hardcoded light-mode Tailwind colors
  and nothing else — left to the browser's default dark media query, the page background flipped
  dark while text stayed dark-on-light-assuming, producing illegible dark-on-dark text (most
  visible on the wedding page's tab bar). Every component across the app (18 files) now carries a
  matching `dark:` Tailwind variant alongside its light-mode color — cards, borders, muted text,
  status badges (amber/red/green/blue), and the primary-button/selected-state pattern, which
  inverts (a near-black button on a light page becomes a near-white button on a dark page) rather
  than just getting a duller shade of the same dark-on-dark. `globals.css` now sets `color-scheme:
  light dark` and defines dark values for the page background/foreground CSS variables under
  `@media (prefers-color-scheme: dark)`. Verified headless under `colorScheme: "dark"` by checking
  actual rendered contrast ratios (via an in-page canvas color read, needed because Tailwind v4's
  computed colors don't always serialize as plain `rgb()`) across the tab bar, page headings, the
  Collaborators and Plan tabs, the primary button, and the separate RSVP page.

- **Name-field character validation**: a planner flagged that guest and wedding names would
  silently accept digits, symbols, and emoji ("John3", "Alex & Jordan 🎉"). Guest first/last name
  and wedding name are now checked against an allowlist wide enough to admit how real names
  actually look — accented letters (José, François), apostrophes (O'Brien), hyphens
  (Smith-Jones), periods (initials, "Jr."/"St.") — rather than a naive "letters only" rule that
  would reject perfectly real names; the wedding-name allowlist is wider still, since it's a title
  ("Alex & Jordan's Wedding, Est. 2026!") rather than a person's name, so it also permits digits,
  ampersands, commas, and exclamation points. Both patterns live in one place
  (`packages/shared/src/validation.ts`) shared by every entry point that touches these fields.
  Three related gaps got fixed alongside it: (1) neither field was ever trimmed, so a name of pure
  whitespace saved as "valid" — both now trim before every other check; (2) the CSV bulk-import
  path validated guest names more weakly than the single-guest add/edit form (no length cap at
  all, and no character check), so a name the regular form would reject could still get in through
  an import — it now applies the identical 100-character cap and allowlist, per-row, alongside the
  import's existing error reporting; (3) the add-guest and create-wedding forms were missing the
  client-side `maxLength` their sibling edit forms already had. Also fixed a pre-existing UX gap
  this surfaced: a 422 validation failure always showed the generic "Validation failed" instead of
  the specific reason (e.g. which character rule tripped) — a new `apiErrorMessage()` helper
  (`apps/web/src/lib/api-client.ts`) surfaces the actual field-level message when one exists, now
  used by guest add/edit and wedding create/rename. Free-text fields (notes, plus-one names, side
  labels, venue name) were deliberately left alone — the planner's concern was specifically about
  name fields, and a character allowlist doesn't make sense for open-ended text.

- **Wider main content area, plus a small responsive audit**: the wedding-detail page and the
  dashboard were both capped at a fixed centered width (`max-w-3xl`/768px and `max-w-5xl`/1024px
  respectively) on every screen size, which was needlessly cramped for space-hungry views like the
  Tables/Seating-plan floor plans — both floor-plan canvases already scale to fill their container
  (`width: "100%", maxWidth: <content-derived size>`), so they were only ever using a fraction of
  a wide monitor's actual space. Both are now capped at `max-w-[1600px]` instead — a large, bounded
  width rather than a literal no-cap, so a genuinely huge (5120px) ultrawide monitor still gets
  reasonable margins instead of content stretching edge to edge. Small-screen behavior is
  unaffected — a max-width only ever engages once the viewport is wider than it, so this is a
  pure widening, not a narrowing anywhere. Auth/guest-facing single-purpose pages (login, signup,
  the invite-accept and RSVP pages) were deliberately left at their existing narrow centered-card
  width, since a login form or RSVP card stretched to fill an ultrawide monitor is worse, not
  better.

  While auditing this at narrow widths, found and fixed two real (pre-existing, unrelated to the
  width change) small-screen overflow bugs: the Guests tab's per-guest Side/RSVP/Lock/Delete
  control row, and the Seating plan tab's "Generate new plan" + "Save as comparison draft" header
  row, both used a plain `flex` row with no wrapping, so at phone width their contents pushed past
  the edge of the screen instead of dropping to a second line. Fixed those, and proactively added
  the same `flex-wrap` to three structurally identical control clusters elsewhere (the Tables tab's
  per-table Accessible/Single-side/Lock controls, the Collaborators tab's per-collaborator
  Role/Access controls — whose own row wrapper was also missing `flex-wrap` — and the Budget tab's
  per-vendor Edit/Delete controls) that weren't yet demonstrably broken with today's data but share
  the exact same failure shape and would break the same way with a longer name, a longer vendor
  contact line, or one more button. Verified with a headless sweep checking for horizontal overflow
  across six viewport widths (390px phone through 3440px super-ultrawide) on every tab; also
  confirmed the main content area actually measures wider on large viewports now, not just capped
  the same as before.

## What's next

**TS-4 is now fully built** — signup/login, per-owner wedding creation, full cross-wedding data
isolation, a collaborator's access re-checked fresh on every request and enforced within 5 seconds
even on an already-open tab, per-wedding renameable side labels, a real Couple-vs-Collaborator role
and invite lifecycle, and (this pass) FR-1.3's last never-built field, the optional note (FR-1.1
through FR-1.6, all four requirements of FR-1.3) — all described above. Nothing is deliberately
deferred on this ticket anymore.

**TS-9 is now fully built.** What's there: the Draft/In Review/Approved status workflow above,
and — since TS-13 — FR-6.2's sharing notification (moving to In Review notifies every
collaborator) and FR-6.3's comments, both described in the TS-13 bullet above. FR-6.4's approval
authority is now enforced for real (closed alongside TS-4's invite-lifecycle work, above): any
Edit-level user can move Draft↔In Review, but Approve is narrower — only the wedding's owner, or a
Couple-role collaborator with at least Comment access, may Approve; a plain Collaborator, even at
Edit level, is refused. FR-6.1's Assigned/Unassigned/Needs Reassignment/Not Attending distinction
(described in its own sub-bullet above) is closed too, now that TS-11's day-of attendance concepts
exist for "Not Attending" to key off of: Unassigned and Needs Reassignment guests each get their
own separate, prominent area in both Plan views rather than a badge inside a nominally-valid
table, and Not Attending guests are excluded outright. Nothing is deliberately left out on this
ticket anymore.

**TS-10 is now built for the full scope FR-7.1–FR-7.7 describe, including FR-7.7's own list of
what a conflict can be about** — "guest, rule, table, floor-plan, comment, status, version, or
assignment data." What's there: manual moves with full hard/soft-rule validation, locks, change
history, FR-7.1's guest-drag-onto-table floor plan, FR-7.5's session-scoped undo/redo, FR-7.7's
revision-based conflict detection and 4-second polling sync for the Current Plan Version itself
(status, version/label, and assignment data — move/unassign/swap), all described above, and — since
this pass — the same revision-based protection extended to guests and seating tables. Two users
editing the same Current Plan Version, guest, or table at the same time now get exactly the
behavior FR-7.7 asks for: the second save is rejected rather than silently overwriting the first,
an on-screen explanation appears, the view refreshes to the real state, and (for the Current Plan
Version) the newer collaborator's own change becomes visible elsewhere within a few seconds without
a manual refresh — verified with a real two-browser Playwright test (`test_live_sync.py`) alongside
the API-level conflict checks (`test_concurrent_conflict.py` for the plan version, and the new
`test_entity_concurrency.py` for guests, tables, rules, and comments together). Seating rules and
comments deliberately do *not* get their own `revision` column: a rule has no edit verb at all
(only add/remove), and a duplicate or conflicting rule is already rejected up front by validation
in `relationships.ts`; a comment is append-only plus a one-way, idempotent resolve. Neither has an
in-place write a revision counter would be protecting against — so instead, deleting a seating rule
that another collaborator already removed now returns a clean, explained 404 rather than a generic
error that silently puts the (already-gone) row back in the list only to fail again on retry, and
resolving a comment now returns the full updated row (including who resolved it) so every
collaborator's view can sync exactly instead of guessing. This is the intentionally different, but
equally deliberate, shape of protection each entity's actual edit surface calls for — not a gap.

**TS-11 (Day-of Mode) is built**, described above. What's deliberately left out, and why: the
`needsReassignment` flag on `seat_assignments` exists in the schema but isn't touched by an
attendance change today — a Not Attending guest's seat is deleted outright rather than flagged,
since FR-8.1 doesn't ask for a "this needs a look" state for them, just an immediately-free seat.
(An earlier version of this paragraph noted that day-of change history entries had no UI to view
them — that gap was already closed by FR-10.1's Activity log, below, which surfaces every
`change_history_entries` row, including `ATTENDANCE_CHANGE`, across the whole wedding; this note
was just never removed from here until now.)

**TS-12 (Export & Print) is built**, described above, including the version labeling and
side-by-side comparison view (described in its own bullet above) that was originally deferred here
— both are now in place. The place-card layout is fixed at 2 columns x 4 rows per page for
readability; a denser layout or a stationery-brand-matched template would be a styling pass on the
same `pdf-lib` code, not a new feature.

**TS-13 (Collaboration & Notifications) is now fully built.** What's there: everything described
above, including the permission-aware UI hiding that was originally deferred here — every tab now
hides/disables the write controls a View/Comment-level collaborator can't use, verified end-to-end
with a real browser session per access level (`test_permission_ui.py`) — and, since this pass,
real email delivery via Resend (`RESEND_API_KEY`/`RESEND_FROM_EMAIL`, both env-var placeholders in
this sandbox — see the FR-10.2 bullet above). What's still deliberately left out, and why:
notifications are polled (the bell refetches every 30s) rather than pushed over a live connection
— same tradeoff TS-10's own live-sync polling makes for the same reason (no websocket/SSE
infrastructure in this pass).

**TS-14 (Non-Functional Requirements) is built**, described above. What's deliberately left out,
and why: everything that's genuinely a deployment/hosting concern rather than application code —
TLS termination for encryption in transit, whole-database encryption and backup/retention policy
at the managed-Postgres level, and uptime monitoring/planned-maintenance scheduling — is
documented as out of scope for this sandboxed environment rather than faked. `Guest.notes` is the
only field encrypted at the application level (field-level AES-256-GCM); it's the specific
personal-data field the requirement is aimed at, not a signal that other fields were overlooked.
NFR-9.2's plain-language requirement is about the messages shown when an action *is* attempted,
which is a separate concern from the tabs' permission-aware hiding of those actions up front
(TS-13, described above) — both are now in place, from two different requirements.

**TS-15 (Integration / End-to-End Scenarios) is built**, described above. Its own description is
explicit that it "has no requirements of its own" — it validates every other story working
together, so there's nothing to defer here in the usual sense. It surfaced two acceptance-criteria
gaps — bulk guest import (a TS-5 gap) and Side-Mixing (a TS-6 gap) — that were never built as part
of TS-5/TS-6. Both have since been closed — see the TS-5 and TS-6 paragraphs below.

**TS-5 (Guest List Management) is now fully built**, including FR-2.9's re-check behavior. What's
there beyond the original individual add/edit/remove flow described above: bulk CSV import and
export (FR-2.4/FR-2.4a), described in its own bullet near the top of "What's implemented" — the
one gap TS-15's testing surfaced — and FR-2.9's generalized re-check, described in its own bullet
under Table & Venue Layout above (it's grouped there since it shares the `needsReassignment`
mechanics FR-4.6 introduced). Editing or importing a change to a guest's Attendance Status, Side,
Relationship Tier, household, or Requires Accessible Table field, or removing the guest, now
re-checks their current seat assignment against hard rules for both the individual guest-edit
endpoint and bulk import, closing the last gap this story had left open.

**TS-6 (Relationships & Seating Rules) is now fully built.** What's there, beyond the original
must/must-not-sit-together/prefer-near/avoid rules described above: the Side-Mixing setting
(FR-3.4) and the Restricted table required-guest list (FR-3.7a) — the two gaps TS-15's own testing
surfaced — and, this pass, FR-3.7's structured Purpose table criteria (Side, Relationship Tier, or
Age Category, scored as a soft preference alongside the free-text `purpose` label) plus the
previously API-only `singleSideOnly` flag now exposed in the Tables tab UI, both described in their
own bullet above. Nothing is deliberately deferred on this ticket anymore.

**TS-7 (Table & Venue Layout) is now fully built** across all seven of its requirements, described
in its own bullet above — shape, quick-create, the optional drag-and-drop floor plan, capacity
enforcement and its overview display, the Accessible-flag re-check, and table-level-only
assignment. Nothing here was deferred as a stretch goal; the Needs Reassignment flag FR-4.6
introduces started out scoped to just the accessible-flag trigger, but has since been generalized
to every field FR-2.9 names — see the FR-2.9 bullet above and the TS-5 paragraph below.

Version labeling and side-by-side comparison are now built (described above) — that closes the
last gap TS-12 had left open, and permission-aware UI hiding and real email delivery (both
described above) close the last gaps TS-13 had left open. All three gaps TS-15 originally surfaced
or that TS-7 depended on (bulk guest import, Side-Mixing, and the visual floor plan) are also
closed. TS-10 is now built for the full scope FR-7.1–FR-7.7 describe (FR-7.1's floor-plan drag,
FR-7.5's undo/redo, and FR-7.7's concurrent-edit sync and conflict detection are all in, described
above; entity-level conflict detection now also covers guests and seating tables directly, with
rules and comments getting the differently-shaped protection their own add/remove/resolve-only edit
surface actually calls for — see the TS-10 paragraph above). TS-4 (Account & Wedding Management)
was found, on a dev-notes audit, to have been missing its own paragraph here entirely despite
being the earliest-built story — three real, previously undocumented gaps surfaced from that audit
(per-wedding renameable side labels, live enforcement on an already-open browser tab, and a full
invite lifecycle distinct from the original immediate add-by-email), and all three are now closed,
described above — TS-4 is fully built. Closing the invite-lifecycle gap also let FR-6.4's approval
authority (under TS-9) be enforced for real, rather than the "any Edit user" simplification that
stood in for it before a Couple role existed to check. FR-6.1, the one piece TS-9 still had open,
is closed too — Unassigned and Needs Reassignment guests each get their own separate, prominent
area in both Plan views rather than an inline badge inside a table the plan no longer considers
valid for them, and TS-9 is now fully built. FR-1.3's last never-built field, an optional note on
the wedding itself, is closed too (settable at creation, editable afterwards from the
Collaborators tab, owner-only) — TS-4 has nothing left deferred at all now, not even the small
field mentioned above for completeness. TS-6's one remaining deferred piece, FR-3.7's structured
Purpose table criteria, is closed too (Side/Tier/Age Category as a soft-preference scoring input),
alongside a small previously-undocumented gap the same pass turned up — the `singleSideOnly` table
flag (FR-3.4) was fully built everywhere except the Tables tab UI, which had no control for it —
and TS-6 is now fully built. With that, every story in the
original requirements doc has a paragraph here reflecting the scope actually built, with every
deliberate gap named and explained rather than left silent.

Most recently, TS-10's one remaining documented gap — FR-7.7's optimistic-concurrency conflict
detection for entities other than the Current Plan Version itself — is closed too: guests and
seating tables now carry the same `revision`/`expectedRevision` contract, and seating rules and
comments get the differently-shaped "already gone" protection their add/remove/resolve-only edit
surface actually calls for, rather than a revision counter with nothing to count (see the TS-10
paragraph above, and `test_entity_concurrency.py`). Real email delivery itself needs no more code
at all — it's been fully wired to Resend since the TS-13 pass described above — the only remaining
step is an account-level one: sign up for a free Resend account, verify a sending domain/address,
and set `RESEND_API_KEY`/`RESEND_FROM_EMAIL` in `apps/web/.env` (see the setup section above).

## The planner-pivot roadmap (new, post-TS-15)

Beyond the original requirements doc closed out above, a September 2026 stakeholder interview
confirmed a bigger-picture pivot: from a couple-facing tool used once per wedding, to a
professional platform a wedding planner uses daily across dozens of active client weddings at
once. Six new Jira stories (TS-16 through TS-21) capture this, in priority order, under the same
TS-2 Workstream — see the shared roadmap doc for full context and the open questions still being
decided.

**TS-16 (Planner Portfolio & Multi-Client Account Model) is done.** FR-11.1
(sortable/filterable/searchable dashboard), FR-11.2 (per-row plan status and unassigned/Needs
Reassignment counts), and FR-11.3 (a "needs attention soonest" default ordering, not a plain
column sort) are built — `GET /api/v1/weddings` now returns a `WeddingSummaryDTO` per wedding,
computed via a `LEFT JOIN LATERAL` against each wedding's Current Plan Version, and the dashboard
filters/sorts/searches that list client-side (deliberately, not a query-param API — see the code
comment in `listWeddingsWithSummaryForUser` for why that's the right tradeoff at the stated
15-50+-wedding portfolio scale). FR-11.4 (reviewing the create-wedding flow's language for
planner-as-owner) was resolved as a **reposition, not a rebuild**: the existing Couple role/invite
flow (TS-4/TS-13) is unchanged underneath, and the create-wedding form now says directly that the
planner owns and manages the wedding and invites the couple as a collaborator afterward — no other
copy in the app implied otherwise.

**TS-17 (Client-Facing RSVP Collection) is done.** A guest can submit their own RSVP through a
unique, unauthenticated token link — modeled directly on the existing invite-token flow (same
32-byte random hex token, lookup by token alone) — reached at `/rsvp/[token]`, requiring no
account (FR-12.1). The submission writes straight into that guest's own record (FR-12.3), bumping
the same FR-7.7 revision counter without itself using `expectedRevision` (an anonymous public form
has nothing to send back as "last seen revision"). A wedding can optionally set an
`rsvpCutoffDate` (Collaborators tab, owner-only); past it, the link still shows the guest's
current answers but refuses further submissions (FR-12.2). On the Guests tab, a planner sees each
guest's "responded"/"no self-RSVP yet" status (set only by the guest's own submission, never a
planner edit — that's what makes the badge mean what it says) and can copy/resend or regenerate a
guest's link on demand (FR-12.4); the raw token itself is deliberately never returned by the
normal guest read endpoints, only by that one dedicated, EDIT-gated endpoint.

**TS-18 (Day-Of Timeline / Run-of-Show) is done.** A per-wedding, chronological schedule of
day-of events (ceremony, processional, toasts, cake cutting, ...) in its own `timeline_entries`
table — no foreign keys pointing in from guests/tables/rules/plan versions, so it's genuinely
independent of the seating plan in both directions (FR-13.1/FR-13.2). Each entry stores a plain
zero-padded 24-hour "HH:MM" time label rather than a real TIME/TIMESTAMP — a run-of-show is a flat
list of clock-face labels, not datetimes — and entries are always listed by `(time, sortOrder)`;
"reorder" is deliberately scoped to only reshuffle entries sharing the *exact same* time, which is
what keeps the list genuinely "always chronological" instead of a free-floating manual order that
could contradict the displayed times. Comments gained a third target type, `TIMELINE_ENTRY`,
alongside `GUEST`/`TABLE` (FR-13.3), reusing the same nullable-target-plus-captured-label pattern
so a comment on a since-removed entry still stands. Access follows the identical View/Comment/Edit
rules as every other tab.

**TS-19 (Reusable Templates) is done.** A planner can save a wedding's table layout plus its
Side-Mixing setting as a reusable `SeatingTemplate` (`POST .../weddings/:id/save-as-template`,
EDIT-gated), then start a brand-new wedding from it (`POST /api/v1/weddings` with an optional
`templateId` + `applyTemplateTables`/`applyTemplateRules` flags). Two architectural calls were
needed to turn FR-14.1/FR-14.2's fairly abstract language into something concrete against this
codebase's actual data model, made the same way FR-11.4 was above — resolved and documented here
rather than blocking on it:
  - **FR-14.2's "structural rules"**: every seating rule this app actually has (`GuestRelationship`
    — Must/Must Not Sit Together, Prefer Near, Avoid) is tied to two specific guest IDs, so it's
    exactly the "guest-specific pairing" FR-14.2 says has no meaning outside its original wedding —
    none of it is ever captured by a template, full stop. FR-14.2's own example of a rule that
    *does* generalize ("the officiant's table is always Restricted") turns out to already be a
    table-level property (`isRestricted`/`purpose`/`purposeCriterion*`) rather than a separate rule
    object, so it's captured as part of each table below; the only other non-guest-specific rule
    signal that exists at all is the wedding's own `sideMixing` setting, captured on the template
    itself.
  - **FR-14.3 (all-or-nothing vs. pick-and-choose)**: saving is one action that always captures
    both pieces together from one source wedding (matches how AC1/AC2 both read). Applying is
    composable, but only at the two-piece granularity FR-14.4's own wording gives — "table layout
    **and/or** rule-shape" — not per-table or per-field: a planner starting a new wedding checks
    either or both of "use its tables" / "use its rule-shape."
  A template belongs to the planner who saved it (`ownerId`), not to any one wedding — it's a
  portfolio-level asset, listed and deleted independent of any wedding access check, reusable
  across all of a planner's weddings and outliving the wedding it was captured from
  (`sourceWeddingId` goes `null` if that wedding is later deleted, the template itself is
  unaffected). Applying a template is a one-time clone, never a live link: every field it seeds
  (including a Restricted table's `isRestricted` flag, but deliberately never its required-guest
  list — see FR-14.2 above) is immediately and fully editable afterward with zero ongoing
  connection back to the template or its source wedding (AC4). Verified in `test_templates.py`:
  saving never leaks guest data, both pieces apply independently, a template requires picking at
  least one piece, ownership is isolated per planner, a template survives its source wedding being
  deleted, and applying it is a true snapshot (editing the clone or the original afterward never
  affects the other).

**TS-20 (Budget & Vendor Tracking) is done.** A planner records vendors per wedding — name,
category (Catering/Venue/Florist/Photography/... plus an `OTHER` category with its own free-text
label, the same enum-plus-label split as the Purpose table criterion), contact info, and a cost —
and can set an overall budget figure, seeing a running total and remaining amount as vendor costs
are recorded (FR-15.1/FR-15.2). Money is always integer cents end-to-end (the schema, the API, the
running-total math) and only ever converted to/from dollars at the UI boundary — never a float —
so a running total can be summed and compared against the budget without drift. FR-15.3 (planner-
entered numbers only, vs. reconciling against real payments/invoicing) was resolved by the ticket
itself, not left to me: the narrower, planner-entered-only scope is what's built, with no payment/
deposit ledger of any kind — a vendor's `contractNotes` free-text field is where that kind of
detail (e.g. "50% deposit due 30 days out") lives instead, matching how the assistant building this
already never handles real financial transactions. "Remaining" is `null` (not a bare negative
number) until a budget is actually set, and goes negative rather than clamping at zero once
recorded costs exceed it. Access follows the same View/Comment/Edit rules as every other working
tab (guests, tables, timeline) — this is ordinary planner data entry, not an administrative wedding
setting — and every vendor edit carries FR-7.7's optimistic-concurrency protection, same as tables
and guests. Verified in `test_budget.py`.

**TS-21 (iOS/Android: On-Site Day-Of Floor Plan) is done** — see its own "Mobile app" section
right below, including the two architecture calls (framework choice, touch-interaction design) it
needed the same way TS-16 and TS-19 above did. That closes out all six planner-pivot stories
(TS-16 through TS-21) in the priority order the September 2026 stakeholder interview set.

## Mobile app (`apps/mobile`, TS-21)

An Expo/React Native TypeScript app, scoped exactly to TS-21's FR-16.1/FR-16.2: a planner viewing
and adjusting the current wedding's seating plan on-site, touch-first, tolerant of unreliable venue
wifi. FR-16.3 explicitly defers everything else (guest list, budget, RSVP, timeline, the portfolio
dashboard) to a later story, so this is deliberately three screens — log in, pick a wedding, the
floor plan — not a mobile port of the whole web app.

**Two open questions the ticket itself flagged as needing a design call, resolved and documented
here (also posted as a dev note on TS-21):**

- **Framework: React Native/Expo, not a Capacitor-wrapped web build.** FR-16.2's offline
  requirement — cache the current plan locally, queue moves made offline, sync them against the
  existing FR-7.7 revision/conflict contract once connectivity returns — is a real local-storage-
  plus-background-sync problem, not a "hide the browser chrome" problem, so a webview wrapper
  around the existing Next.js UI would fight the requirement rather than serve it. `@seatwise/shared`
  has zero Node-only dependencies (only `zod`), so it imports into Expo unchanged for validation and
  DTO types — nothing about the shared package needed to change to add this app, exactly as this
  README used to say it wouldn't.
- **Touch interaction: tap-to-select-guest, then tap-to-place-at-table, not a literal free-drag
  port.** The ticket's own context note flags that "touch-first drag-and-drop needs its own design,
  not just bigger hit targets" — a literal drag gesture degrades badly on a real phone at a crowded
  table layout (small drop targets, a thumb covering the destination mid-drag). Tapping a guest chip
  to select them, then tapping a table to move them there, is the same underlying move the web
  Plan tab already does one at a time (`POST .../plan-versions/:id/assignments`, unchanged) — only
  the gesture is simpler for touch, not the action or its validation.

**What's built:**

- **Auth**: `src/api/auth.ts` — the exact same `/api/v1/auth/login` endpoint the web app's login
  form calls, but this client keeps the `token` field from the JSON response and sends it back as
  `Authorization: Bearer <token>` on every request (`src/api/client.ts`), instead of relying on the
  httpOnly cookie the web app uses — precisely the mobile contract `apps/web/src/lib/auth.ts`'s own
  comment on `getAuthUser()` already described. The session (user + token) persists in
  `AsyncStorage` so a planner isn't asked to log in again every time they open the app at the venue.
- **Wedding picker**: a minimal list (`GET /api/v1/weddings`) — just enough to choose which
  wedding's floor plan to load, not a dashboard. FR-16.3 stays out of scope here on purpose.
- **Floor plan screen**: fetches tables, guests, and the current plan version (same
  `GET .../plan-versions` → find the row with `isCurrent: true`, falling back to the first result
  only if the list is otherwise empty — updated when FR-5.6/TS-8 made a Comparison Draft able to
  outnumber Current without replacing it, since "the first result" stopped reliably meaning
  current at that point; see the FR-5.6 bullet under Automated seat assignment engine above),
  merges them into a table-by-table view
  reusing each table's saved `positionX`/`positionY` from FR-7.1 so the picture matches the web
  floor plan, and renders guest chips per table plus an Unassigned tray. Tap a guest, then tap a
  table (or the Unassigned tray) to move them — same `POST .../assignments` endpoint, same
  hard/soft-rule validation and `expectedRevision`/409-conflict contract FR-7.7 already defined; a
  soft-rule warning surfaces as an alert, a hard-rule rejection reverts the attempted move with an
  explanation, exactly mirroring the web Plan tab's own conflict handling.
- **Offline (FR-16.2)**: the current plan version is cached in `AsyncStorage` on every successful
  load or sync, so re-opening the app at a venue with no signal still shows the last-known plan
  rather than a blank screen. A move made while offline (detected via `@react-native-community/
  netinfo`, or a failed `fetch` even when NetInfo hasn't noticed yet) applies immediately to the
  local view (marked with a small "pending sync" indicator) and is queued in `src/offline/queue.ts`
  rather than lost. On reconnect, the queue replays against the real endpoint in order, reusing
  FR-7.7's existing revision contract unchanged — no new conflict mechanism was invented for mobile:
  - A **conflict** (someone else's save landed first) stops the replay there, shows the planner the
    message and the fresh server state, and never silently reapplies the rest of the queue on top of
    it — the still-unsynced moves are surfaced by name so the planner can review and manually redo
    whichever still make sense, per AC2's "never silently overwriting a newer change."
  - A **rejection** (a genuine hard-rule violation, e.g. the table filled up in the meantime) has no
    fresh state to show (the server never changed), but invalidates the `expectedRevision` every
    *later* queued move assumed — so the app re-fetches the real current revision and renumbers the
    remainder (`rebaseQueue`) before continuing, rather than letting each one fail its own confusing
    conflict in turn.
  - A **network** failure mid-replay just stops and waits for the next reconnect or manual "Sync
    now" tap.
- **Tests**: `src/planMerge.ts` (merging tables/guests/plan-version into the floor-plan view, and
  applying a move locally before the server confirms it) and `src/offline/queue.ts` (the replay
  state machine above, including the conflict/rejection/offline/rebase paths) are plain TypeScript
  with no React Native or device dependency, and have a real executed Jest suite
  (`apps/mobile/__tests__/`, `pnpm --filter @seatwise/mobile test` — 15 tests, all passing) — the
  same bar the rest of this repo's ticket work has held to. The screens themselves (`App.tsx`,
  `src/screens/*.tsx`) type-check cleanly (`npx tsc --noEmit`) but aren't exercised by an automated
  test here: there's no iOS/Android simulator or device available in this sandbox to drive them, so
  that pass is left for Tom's own machine (see below).

**Running it**: `pnpm install` at the repo root picks up `apps/mobile` automatically (the existing
`apps/*` workspace glob needs no changes), then `cd apps/mobile && pnpm start` opens Expo's
dev-server UI — scan the QR code with Expo Go on a phone, or press `i`/`a` for a simulator/emulator.
One real gotcha worth knowing up front: the web app's dev server binds to `localhost:3000`, but
"localhost" means a different machine depending on where this app is running — the iOS Simulator
reaches the Mac's own localhost directly, the Android emulator needs `10.0.2.2` for the same thing,
and a real phone in Expo Go is a separate device on the same wifi and needs the Mac's actual LAN IP
(e.g. `http://192.168.1.23:3000`). Set `EXPO_PUBLIC_API_BASE_URL` to whichever of those applies
before starting (`src/config.ts` falls back to the Simulator's `localhost:3000` if it's unset).
`metro.config.js` has the pnpm-monorepo-specific settings (watched folders, symlink resolution)
`@seatwise/shared`'s raw-TypeScript-source import needs — see its own comments for why.

**Deliberately out of scope, per FR-16.3**: guest list management, budget tracking, RSVP
collection, the day-of timeline, and the portfolio dashboard aren't in this app at all — a planner
needing any of those still reaches for the web app. There's also no push notification wiring for a
sync completing in the background; the app has to be open (or brought to the foreground) for a
queued move to replay.

## Playwright test automation framework (TS-22, in progress)

A reusable Playwright Test framework is being built out per
`PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (also the resumable implementation ledger — see its own
Progress Dashboard for what's done). Tracked in Jira as TS-22 with one story per stage (TS-23
through TS-34). **`PLAYWRIGHT_TESTING.md` is the full manual-tester/authoring guide** (Stage 04) —
start there if you're writing or reviewing a test. The basics, as of Stage 04:

- **Install:** `pnpm install` (top-level, same as the rest of the repo) gets `@playwright/test`
  itself; then `pnpm pw:install` downloads the Chromium browser binary Playwright needs (Firefox
  and WebKit stay uninstalled/unused for now — see the spec's Decision Log, DEC-003).
- **Run:** `pnpm pw:test` runs the Chromium E2E project plus the framework's own unit tests.
  `pnpm pw:test:headed` / `pnpm pw:test:debug` / `pnpm pw:test:ui` are the usual Playwright
  debugging modes. `pnpm pw:validate` type-checks the framework, validates all governance/metadata
  (including, as of Stage 04, the real test suite's own authoring standards — see
  `pnpm pw:lint-tests` below), and lists what would run, without actually running anything.
- **Reports:** `pnpm pw:report` opens the most recent HTML report (generated under
  `artifacts/playwright/runs/` — gitignored, regenerated per run; the framework's own richer report
  templates arrive in Stage 06).
- **Layout:** `e2e/tests/` holds application tests (`guest-management.spec.ts` and
  `guest-viewing.spec.ts` are the mutating/read-only reference tests; `unit/` holds pure-logic unit
  tests for the `e2e/` support code) plus page objects (`e2e/pages/`), component objects
  (`e2e/components/`), fixtures (`e2e/fixtures/`), and test-data/support helpers
  (`e2e/data/`, `e2e/support/`); `playwright-framework/` holds the framework's own source and
  self-tests (environment config, the production/mutation safety guard, metadata/tag validation,
  scoring, and — as of Stage 04 — static test-authoring lint rules under
  `playwright-framework/validation/`); `quality/` holds versioned config and audit reports;
  `artifacts/playwright/` holds generated, gitignored run output.
- **Test-authoring standards and enforcement (Stage 04):** `pnpm pw:lint-tests` statically checks
  every real `e2e/tests/**/*.spec.ts` file (no browser launch needed) against the rules
  `PLAYWRIGHT_TESTING.md` documents — no raw selectors/screenshots/fixed-waits in a test file, no
  committed `test.only`, no unreasoned skip/fixme/fail, no swallowed errors, every test asserts
  something, every test's ID is prefixed with its file's name — plus the metadata governance
  checks below run against the real suite for the first time (previously only exercised against
  synthetic data in a unit test). Folded into `pnpm pw:validate`.
- **Production safety:** there's no real production deployment of this app yet, so
  `PRODUCTION_HOSTNAMES` defaults to empty and every target is treated as non-production. The guard
  itself (`e2e/support/productionGuard.ts`) is fully implemented and unit-tested so that whenever a
  real production host does exist, it can be added to that list and mutating tests will be blocked
  against it automatically, by default, with no further code changes needed.
- **Test governance and value model (Stage 02):** `quality/requirements.yaml`,
  `quality/tag-taxonomy.yaml`, and `quality/test-value-model.yaml` (+ generated
  `quality/test-value-model.md`) are the canonical, versioned data behind the framework's tagging
  and scoring rules — see the spec's Section 8/9 for what each encodes. `pnpm pw:validate-metadata`
  checks all of it (and every other quality/*.yaml file) for consistency; `defineQualityTest` (in
  `playwright-framework/metadata/`, re-exported with fixtures from `e2e/fixtures/index.ts`) is the
  typed helper every real application test uses to attach governed metadata (objective, expected
  outcome, requirement IDs, tags) and have it validated at collection time.
