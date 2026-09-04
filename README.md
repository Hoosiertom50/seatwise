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
- Every list/detail endpoint enforces ownership — you can't read or modify another account's
  wedding, guests, rules, tables, or plan versions by guessing an ID, and a seating rule can't be
  created between guests from two different weddings even if you have access to both.

## What's next

**TS-9 is only partially built.** What's there: the Draft/In Review/Approved status workflow
above (FR-6.4, FR-6.5, FR-6.6). What's deliberately deferred, and why: FR-6.1's full
Assigned/Unassigned/**Needs Reassignment**/**Not Attending** distinction depends on concepts
(day-of attendance changes) that don't exist yet — that's TS-11 (Day-Of Mode); the schema
already has a `needsReassignment` flag on each seat assignment ready for that. FR-6.2 (sharing a
plan with in-app/email notifications) and FR-6.3 (comments on a table or guest assignment, gated
by View/Comment/Edit permission) are left out entirely for now — they need a real
collaborator/permissions model (inviting other accounts to a wedding with a permission level),
which is substantial enough to be its own slice rather than something to fake with the
single-owner model this app has today. Approve is currently allowed for any signed-in owner,
standing in for "Planner/Owner or a Couple user with Comment/Edit" until that permissions model
exists.

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

Table/venue *visual* layout (drag-and-drop floor plan), export/print, collaboration &
notifications, and richer plan-versioning (labeling/comparing/restoring versions) are modeled in
`schema.prisma` already and map to the remaining Jira stories (TS-7's visual piece, TS-12 through
TS-15, and the rest of TS-9/TS-10). Each can be built as its own vertical slice on top of this
foundation.

## Mobile later

Nothing here should need to change to add an iOS/Android app: point a React Native/Expo app (or
a Capacitor-wrapped build of this same web app, if that's the faster route when the time comes)
at the same `/api/v1` endpoints, reuse `@seatwise/shared` for validation and types, and store the
token from the auth response instead of relying on the cookie.
