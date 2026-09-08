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
packages/shared/      Zod schemas & shared TS types (validation rules, DTOs) — importable by
                       the web app today and a React Native/Expo app later, unchanged
packages/db/           Data model (Prisma schema) + the query layer the API routes use
```

## Getting started (on your own machine)

Prerequisites: Node 20+, pnpm (`corepack enable` will get you the right version), and a
PostgreSQL server (local install, Docker, or a hosted one like Supabase/Neon).

```bash
pnpm install
```

Create `apps/web/.env` (copy `.env.example` at the repo root):

```
DATABASE_URL="postgresql://user:password@localhost:5432/seatwise_dev?schema=public"
JWT_SECRET="a long random string"
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
Seating rules and Tables tabs on a wedding's page.

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

`schema.prisma` stays the source of truth for the data model either way. Once you run
`prisma migrate dev` on your machine (or in CI), Prisma will want to create its own migration
history; either let it do that fresh, or run `npx prisma migrate resolve --applied 0001_init`
first so it recognizes the hand-applied migration as already done. If you'd rather adopt Prisma
Client for the query layer instead of the current `pg`-based one, that's a reasonable next step
once `prisma generate` can run — the schema and `@prisma/adapter-pg` (already installed) are set
up for it.

## What's implemented

- **Account & Wedding Management** (TS-4, partial — see below): email/password signup and login,
  JWT issued on both, session check endpoint. One account holds any number of weddings
  (FR-1.1), each scoped to its owner with a name, optional event date, and venue name (FR-1.3,
  partial — there's no separate "note" field). Every wedding's guests, rules, tables, plan
  versions, comments, and activity are fully isolated from every other wedding, even under the
  same owner — cross-wedding access is a 404 in both directions (FR-1.2, verified in
  `test_e2e_isolation.py`). A collaborator's access (added under TS-13, below) is re-checked
  fresh against the database on every request rather than cached, so a permission change or
  revocation is enforced on that user's very next action (FR-1.5), and the wedding page itself
  polls its own access level every 4 seconds so an already-open, idle browser tab picks up a
  change within the same 5-second requirement, without the user taking any action (FR-1.6 — see
  below).
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
  - **Still deliberately left out, and why:** FR-1.4/FR-1.4a ask for a distinct
    Couple-vs-Collaborator role separate from permission level, plus a full invite lifecycle (an
    emailed invite carrying no guest data, with pending/accepted/expired/revoked states) — what's
    built instead (TS-13) is simpler: an owner adds an already-registered account directly by
    email at a permission level, with access granted immediately and no invite token or pending
    state. This is next.
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
    (partyName), or Requires Accessible Table — through this tab's inline controls, a future full
    edit form, or a bulk import update row — re-checks hard rules and flags **Needs
    Reassignment** if their current seat is no longer valid, or (for Attendance Status specifically)
    frees their seat outright the same way the dedicated Day-of endpoint always has.
  - **Deliberately left out:** Excel (`.xlsx`) isn't parsed, only CSV — spreadsheet software
    exports CSV directly, and adding a binary-format parser for the same acceptance criteria
    wasn't judged worth a new dependency for this pass.
- Seating rules between guests (must sit together / must not sit together / prefer near / avoid),
  with the FR-0.1 hard-rule invariant enforced server-side: a pair of guests can't simultaneously
  be required to sit together and forbidden from it — that's blocked outright with a clear error,
  not just left to the UI to prevent.
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
    room to do so, and surfaced as a non-blocking warning (naming the guests involved) when they
    can't be.
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
- **Plan review status** (TS-9, partial — see below): the Current Plan Version (the latest one
  generated) moves through Draft → In Review → Approved. Approving requires a complete plan
  (FR-0.1) and only ever applies to the current version — an older, superseded version's status
  can no longer be changed. Approving is a checkpoint, not a lock: nothing about assignments,
  rules, guests, or tables becomes read-only. If the plan is edited after approval, it stays
  Approved but shows a "Modified since approval" indicator (first/latest change time); moving
  status back to Draft or In Review clears that indicator without deleting the underlying
  history. Every status change is recorded as an immutable Change History entry (user,
  timestamp, from → to).
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
  - **FR-7.7** (scoped to the Current Plan Version — see below): every write that touches the
    Current Plan Version's assignments, status, or label (move, unassign, swap, status change,
    relabel) now carries a `revision` counter. A client sends back the revision it last loaded;
    if someone else's save has moved it on, the write is rejected outright — with a 409 and the
    fresh, currently-committed plan version attached — instead of silently overwriting what they
    just did. The rejected user sees "This plan changed since you loaded it — someone else's
    change landed first," the view refreshes to the real state automatically (no page reload),
    and their own attempted change is simply not applied, so they can look at what's there now
    and retry deliberately. Separately, the Seating plan tab polls for a newer revision every 4
    seconds while a Current Plan Version is open (paused while a move/undo/redo/status/label save
    of your own is in flight, so it can't race your own write) and merges in whatever a
    collaborator has since saved — meeting the "visible within five seconds without a manual
    refresh" requirement without needing websocket/SSE infrastructure. `expectedRevision` is
    optional on every one of these endpoints, so this is purely additive: a caller that omits it
    gets the exact old behavior.
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

## What's next

**TS-4 is only partially built.** What's there: signup/login, per-owner wedding creation, full
cross-wedding data isolation, a collaborator's access being re-checked fresh on every request, and
— since this pass — FR-1.3a's per-wedding renameable side labels and FR-1.6's live enforcement on
an already-open browser tab (FR-1.1, FR-1.2, FR-1.3 minus its note field, FR-1.3a, FR-1.5, FR-1.6)
— all described above. What's still deliberately deferred, and why: FR-1.4/FR-1.4a's fuller invite
model (a Couple-vs-Collaborator role distinct from permission level, plus a real
invite-with-expiry/revocation lifecycle) hasn't been built yet — TS-13's simpler "add an existing
account by email, access granted immediately" stands in for it today, which covers the
permission-gating half of TS-13's own scope but not TS-4's original, more specific invite-flow
requirement. That's a real, buildable next slice, being worked next.

**TS-9 is only partially built.** What's there: the Draft/In Review/Approved status workflow
above (FR-6.4, FR-6.5, FR-6.6), and — since TS-13 — FR-6.2's sharing notification (moving to In
Review notifies every collaborator) and FR-6.3's comments, both described in the TS-13 bullet
above. What's still deliberately deferred, and why: FR-6.1's full
Assigned/Unassigned/**Needs Reassignment**/**Not Attending** distinction depends on concepts
(day-of attendance changes) that don't exist yet — that's TS-11 (Day-Of Mode); the schema
already has a `needsReassignment` flag on each seat assignment ready for that. Any Edit-level
collaborator (not just the owner) can move a plan's status, standing in for "Planner/Owner or a
Couple user with Comment/Edit" — Comment-level users can comment but not change status, matching
the permission model FR-6.2/6.3 describe.

**TS-10 is now built for the scope FR-7.1–FR-7.7 actually describe: the Current Plan Version.**
What's there: manual moves with full hard/soft-rule validation, locks, change history, FR-7.1's
guest-drag-onto-table floor plan, FR-7.5's session-scoped undo/redo, and — since this pass —
FR-7.7's revision-based conflict detection and 4-second polling sync, all described above. Two
users editing the same Current Plan Version at the same time now get exactly the behavior FR-7.7
asks for: the second save is rejected rather than silently overwriting the first, an on-screen
explanation appears, the view refreshes to the real state, and the newer collaborator's own
change becomes visible elsewhere within a few seconds without a manual refresh — verified with a
real two-browser Playwright test (`test_live_sync.py`) alongside the API-level conflict checks
(`test_concurrent_conflict.py`). What's still deliberately out of scope, and why: FR-7.7's own
list of what a conflict can be about — "guest, rule, table, floor-plan, comment, status, version,
or assignment data" — reads broader than just the Current Plan Version's own writes; this pass
covers status, version (label), and assignment (move/unassign/swap) for that one entity, since
that's what TS-10's own requirement grouping and the "Manual Override" section are actually about.
Editing a guest, a rule, a table, or a comment concurrently still has no optimistic-concurrency
check of its own — the second save there simply wins, same as before this pass — since each of
those is really its own entity with its own edit surface (TS-3/TS-5/TS-6/TS-7/TS-13), and giving
each one the same revision-counter treatment is realistically its own slice of work rather than a
few hours' extension of this one.

**TS-11 (Day-of Mode) is built**, described above. What's deliberately left out, and why: change
history entries are recorded for every day-of action (and every manual move / status change
before it), but there's still no UI anywhere to *view* that history — it's all sitting in the
`change_history_entries` table, verified directly, waiting on a "History" panel that's really a
piece of its own (arguably part of TS-9's fuller FR-6.1 status/reassignment picture). The
`needsReassignment` flag on `seat_assignments` exists in the schema but isn't touched by an
attendance change today — a Not Attending guest's seat is deleted outright rather than flagged,
since FR-8.1 doesn't ask for a "this needs a look" state for them, just an immediately-free seat.

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

**TS-6 (Relationships & Seating Rules) is now fully built**, aside from one deliberately deferred
stretch goal. What's there, beyond the original must/must-not-sit-together/prefer-near/avoid rules
described above: the Side-Mixing setting (FR-3.4) and the Restricted table required-guest list
(FR-3.7a), both described in their own bullet above — these were the two gaps TS-15's own testing
surfaced. What's still deliberately left out, and why: FR-3.7's fuller idea of *structured*
seating criteria on a table's "purpose" (e.g. a table's purpose implying a preferred side, tier, or
age category as its own soft-preference input, beyond the plain free-text `purpose` field that
already exists) was scoped out as a stretch goal relative to the two gaps above — it wasn't
something TS-15's testing actually blocked on, and free-text `purpose` already covers the same
need for a human reading the table list, just without the engine reading it as a preference input.

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
closed. TS-10 is now built for the Current Plan Version scope FR-7.1–FR-7.7 describe (FR-7.1's
floor-plan drag, FR-7.5's undo/redo, and FR-7.7's concurrent-edit sync and conflict detection are
all in, described above; entity-level conflict detection for guests/rules/tables/comments remains
a documented, deliberate gap — see the TS-10 paragraph above). TS-4 (Account & Wedding Management)
was found, on a dev-notes audit, to have been missing its own paragraph here entirely despite
being the earliest-built story — three real, previously undocumented gaps surfaced from that audit
(per-wedding renameable side labels, a full invite lifecycle distinct from today's immediate
add-by-email, and live enforcement on an already-open browser tab), and two of the three (FR-1.3a's
side labels, FR-1.6's open-tab enforcement) are now closed, described above. The remaining one
(FR-1.4/FR-1.4a's invite lifecycle) is being worked next. With that, every story in the
original requirements doc has a paragraph here reflecting the scope actually built, with every
deliberate gap named and explained rather than left silent.

## Mobile later

Nothing here should need to change to add an iOS/Android app: point a React Native/Expo app (or
a Capacitor-wrapped build of this same web app, if that's the faster route when the time comes)
at the same `/api/v1` endpoints, reuse `@seatwise/shared` for validation and types, and store the
token from the auth response instead of relying on the cookie.
