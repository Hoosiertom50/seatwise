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

- Email/password signup and login, JWT issued on both, session check endpoint.
- Create/list weddings, scoped to the signed-in owner.
- Add/list/update (RSVP status)/remove guests within a wedding, with tier, party/household
  grouping, headcount, and an accessible-table flag.
- Seating rules between guests (must sit together / must not sit together / prefer near / avoid),
  with the FR-0.1 hard-rule invariant enforced server-side: a pair of guests can't simultaneously
  be required to sit together and forbidden from it — that's blocked outright with a clear error,
  not just left to the UI to prevent.
- Tables: create/update/delete tables for a wedding with a name, seat capacity, optional purpose
  (e.g. "Kids table"), a restricted flag, and an accessible-seating flag. (A visual drag-and-drop
  floor plan is a follow-on enhancement — this pass is the data layer plus a straightforward
  list-based UI.)
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
  - Restricted tables (a specific required guest list, e.g. a reserved family table) are left
    out of automatic assignment for now — the schema tracks the flag, but seating those is a
    manual/later step, since a per-table required-guest list isn't modeled yet.
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
- **Collaboration & Notifications** (TS-13, FR-10.1–FR-10.3): a real multi-user model on top of
  the single-owner one every earlier story used.
  - A wedding's owner can invite any other existing Seatwise account by email at **View**,
    **Comment**, or **Edit** access (each level includes everything below it; the owner is
    implicitly above Edit and never has their own row in the collaborator table). Every existing
    endpoint — guests, tables, rules, plan versions, manual moves, day-of mode, export, restore —
    now checks this access level instead of pure ownership: reads need View, writes need Edit;
    renaming/deleting the wedding and managing collaborators stay owner-only.
  - **Comments** (FR-10.3) attach to a specific guest or table, support one level of threaded
    replies, and can be resolved by the original commenter or anyone with Edit access (nobody
    else). A comment's target label (e.g. "Guest: Jane Doe") is captured once at creation, so if
    that guest or table is later renamed or removed, the comment stays understandable instead of
    silently losing its context or breaking — it's just shown as historical ("removed").
  - **Activity log** (FR-10.1): a single chronological feed across *every* plan version of a
    wedding (every earlier story's Change History entries were only ever queryable one version at
    a time) — status changes, manual moves/swaps, attendance changes, and restores, newest first,
    each with who did it and when.
  - **In-app notifications** (FR-10.2): the owner and every other collaborator (except whoever
    caused it) gets a notification when a plan is shared for review, a comment gets a reply, or —
    once the Current version is Approved — a guest's table changes, a guest is added or removed,
    or attendance changes; any other status transition also notifies. A bell in the header (every
    page) shows the unread count and a dropdown to read/mark-read. Each wedding has a per-wedding
    email opt-out (on by default); a stubbed "email send" logs what it would have sent (there's no
    real provider wired up in this environment) and is written so a failed send can never block
    the in-app notification or the action that triggered it.
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

## What's next

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

**TS-10 is only partially built.** What's there: manual moves with full hard/soft-rule
validation, locks, and change history, described above. What's deliberately deferred, and why:
FR-7.1 asks for dragging a guest between tables in a *visual* floor-plan view — there's no visual
floor plan yet (that's TS-7's drag-and-drop piece), so this pass uses an equivalent
select-a-table control on the existing list-based seating plan view instead; the same validated
move endpoint is exactly what a future drag interaction would call. FR-7.5 (session-scoped
undo/redo) and FR-7.7 (sub-5-second concurrent-edit sync with conflict detection) are left out —
they need client-side state and either a live connection (websockets/polling) or optimistic-
concurrency version checks that are substantial enough to be their own slice; today, two users
editing the same plan at the same time can each save a change, and the second simply overwrites
what the first saw (no conflict warning yet).

**TS-11 (Day-of Mode) is built**, described above. What's deliberately left out, and why: change
history entries are recorded for every day-of action (and every manual move / status change
before it), but there's still no UI anywhere to *view* that history — it's all sitting in the
`change_history_entries` table, verified directly, waiting on a "History" panel that's really a
piece of its own (arguably part of TS-9's fuller FR-6.1 status/reassignment picture). The
`needsReassignment` flag on `seat_assignments` exists in the schema but isn't touched by an
attendance change today — a Not Attending guest's seat is deleted outright rather than flagged,
since FR-8.1 doesn't ask for a "this needs a look" state for them, just an immediately-free seat.

**TS-12 (Export & Print) is built**, described above. What's deliberately left out, and why: a
version can only ever be restored wholesale — there's no "compare two versions side by side" view
(mentioned as a nice-to-have in the FR-9.4 area, but not in its acceptance criteria) and no
labeling a version with a custom name yet (`PlanVersion.label` exists in the schema but nothing
sets it — versions are only ever referred to by number today). The place-card layout is fixed at 2
columns x 4 rows per page for readability; a denser layout or a stationery-brand-matched template
would be a styling pass on the same `pdf-lib` code, not a new feature.

**TS-13 (Collaboration & Notifications) is built**, described above. What's deliberately left
out, and why: the existing tabs (Guests, Tables, Rules, Seating plan, Day-of mode) don't yet
*hide* controls a View/Comment-level collaborator can't use — server-side enforcement is complete
and verified (a 403 comes back for every disallowed write), but e.g. a View-only collaborator
still sees an "Add guest" button that then fails with that 403 rather than being hidden or
disabled up front. Making every existing tab permission-aware in the UI, not just the API, is a
straightforward follow-on pass, not a new capability. Notifications are polled (the bell refetches
every 30s) rather than pushed over a live connection — same tradeoff TS-10 already made for
concurrent-edit sync, and for the same reason (no websocket/SSE infrastructure in this pass).
There's no real email provider wired up — `sendEmailNotification` is a stand-in that logs what it
would send; swapping in Resend/SendGrid/SES means replacing that one function's body, not any of
its call sites or the notification logic around it.

**TS-14 (Non-Functional Requirements) is built**, described above. What's deliberately left out,
and why: everything that's genuinely a deployment/hosting concern rather than application code —
TLS termination for encryption in transit, whole-database encryption and backup/retention policy
at the managed-Postgres level, and uptime monitoring/planned-maintenance scheduling — is
documented as out of scope for this sandboxed environment rather than faked. `Guest.notes` is the
only field encrypted at the application level (field-level AES-256-GCM); it's the specific
personal-data field the requirement is aimed at, not a signal that other fields were overlooked.
The existing tabs' hide-controls-by-permission gap noted under TS-13 above is unchanged by this
story — NFR-9.2's plain-language requirement is about the messages shown when an action *is*
attempted, not about hiding buttons a lower-access collaborator can't use.

Table/venue *visual* layout (drag-and-drop floor plan) and version labeling/comparison are
modeled in `schema.prisma` already and map to the remaining Jira stories (TS-7's visual piece,
TS-15, and the rest of TS-10). Each can be built as its own vertical slice on top of this
foundation.

## Mobile later

Nothing here should need to change to add an iOS/Android app: point a React Native/Expo app (or
a Capacitor-wrapped build of this same web app, if that's the faster route when the time comes)
at the same `/api/v1` endpoints, reuse `@seatwise/shared` for validation and types, and store the
token from the auth response instead of relying on the cookie.
