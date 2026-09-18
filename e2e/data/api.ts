/**
 * Stage 03 — project-specific test-data setup/cleanup interface (spec Stage 03 task: "Implement
 * project-specific data setup/cleanup interfaces with explicit no-op or unsupported states").
 *
 * Creates and tears down real records through the app's own REST API (never direct SQL), reusing
 * the calling `APIRequestContext`'s cookie jar -- so this must be called with a request context
 * that has already authenticated (see e2e/support/auth.ts), never with embedded credentials of
 * its own.
 */

import type { APIRequestContext } from "@playwright/test";

export class UnsupportedCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCleanupError";
  }
}

export interface CreatedWedding {
  id: string;
  name: string;
}

export type SideMixing = "KEEP_SEPARATE" | "BALANCED_MIX" | "FULLY_MIXED";

// TS-51 (REQ-REUSABLE-TEMPLATES, FR-14.4): the optional template-seeding fields createWeddingSchema
// accepts alongside the base wedding fields, plus sideMixing itself (settable at creation, distinct
// from applyTemplateRules overriding it afterward).
export interface CreateWeddingOptions {
  sideMixing?: SideMixing;
  templateId?: string;
  applyTemplateTables?: boolean;
  applyTemplateRules?: boolean;
}

// TS-51: the full wedding row (GET .../weddings/:id), as opposed to CreatedWedding's bare
// id/name -- needed to assert guestCount and sideMixing on a template-seeded wedding.
export interface WeddingDetail {
  id: string;
  name: string;
  sideMixing: SideMixing;
  guestCount: number;
}

// TS-51: a template row as returned by the list endpoint (GET /api/v1/templates) -- no `tables`
// array (that's only on the single-template detail read).
export interface SeatingTemplateSummary {
  id: string;
  ownerId: string;
  name: string;
  sourceWeddingId: string | null;
  sourceWeddingName: string | null;
  sideMixing: SideMixing;
  tableCount: number;
}

export interface SeatingTemplateTable {
  id: string;
  label: string;
  capacity: number;
  isRestricted: boolean;
  isAccessible: boolean;
  isLocked: boolean;
  purpose: string | null;
  purposeCriterionType: "SIDE" | "TIER" | "AGE_CATEGORY" | null;
  purposeCriterionValue: string | null;
  singleSideOnly: boolean;
  shape: "ROUND" | "RECTANGULAR" | "SQUARE" | "OVAL" | "OTHER";
  positionX: number | null;
  positionY: number | null;
  sortOrder: number;
}

export interface SeatingTemplateDetail extends SeatingTemplateSummary {
  tables: SeatingTemplateTable[];
}

export interface CreatedGuest {
  id: string;
  firstName: string;
  lastName: string;
}

export interface CreateGuestInput {
  firstName: string;
  lastName: string;
  email?: string;
  // TS-38: the seat-assignment engine's own inputs -- optional because most callers (guest
  // list/RSVP tests) only need a plain attending guest, but the engine tests need to set these
  // explicitly rather than rely on the API's own defaults (ATTENDING/false/false) to build a
  // specific scenario (a Not Attending guest, a guest requiring an accessible table, a guest
  // created already locked).
  dayOfAttendance?: "ATTENDING" | "NOT_ATTENDING";
  requiresAccessibleTable?: boolean;
  isLocked?: boolean;
  // TS-40: the rest of createGuestSchema's optional fields -- needed to build specific Guest List
  // Management scenarios (a household/partyName, free-text notes, an explicit tier/side/age
  // category/RSVP status, a plus-one note, a specific headcount) rather than relying on the API's
  // own defaults for every field.
  partyName?: string | null;
  notes?: string | null;
  headcount?: number;
  tier?: "VIP" | "FAMILY" | "FRIEND" | "PLUS_ONE" | "OTHER";
  rsvpStatus?: "PENDING" | "CONFIRMED" | "DECLINED";
  side?: "BRIDE" | "GROOM" | "BOTH";
  ageCategory?: "ADULT" | "CHILD" | "INFANT";
  plusOneNames?: string | null;
}

export interface CreatedTable {
  id: string;
  label: string;
  capacity: number;
}

// TS-54: a single table with the specific flags the cross-cutting hard-rule tests need
// (isRestricted, isAccessible) -- the quick-create endpoint below only makes plain identical
// tables, with no way to set either flag.
// TS-42: extended with the rest of createTableSchema's optional fields -- needed to build
// Relationships & Seating Rules scenarios (a Single-Side-Only override, a Purpose table's
// structured criterion) rather than relying on the API's own defaults for every field.
export interface CreateTableInput {
  label: string;
  capacity: number;
  isRestricted?: boolean;
  isAccessible?: boolean;
  isLocked?: boolean;
  purpose?: string | null;
  purposeCriterionType?: "SIDE" | "TIER" | "AGE_CATEGORY" | null;
  purposeCriterionValue?: string | null;
  singleSideOnly?: boolean;
  shape?: "ROUND" | "RECTANGULAR" | "SQUARE" | "OVAL" | "OTHER";
}

export interface CreatedTableDetail extends CreatedTable {
  isRestricted: boolean;
  isAccessible: boolean;
  isLocked: boolean;
  purpose: string | null;
  purposeCriterionType: "SIDE" | "TIER" | "AGE_CATEGORY" | null;
  purposeCriterionValue: string | null;
  singleSideOnly: boolean;
  // TS-51: needed to assert a template-cloned table's shape matches the source table's.
  shape: "ROUND" | "RECTANGULAR" | "SQUARE" | "OVAL" | "OTHER";
  requiredGuestIds: string[];
  revision: number;
}

// TS-42: the fields a table PATCH may change -- a subset of CreateTableInput plus the
// optimistic-concurrency token the API accepts back.
export interface UpdateTableInput extends Partial<CreateTableInput> {
  expectedRevision?: number;
}

export interface QuickCreateTablesInput {
  count: number;
  capacity: number;
  shape?: "ROUND" | "RECTANGULAR" | "SQUARE" | "OVAL" | "OTHER";
  labelPrefix?: string;
}

export type RelationshipType = "MUST_SIT_TOGETHER" | "MUST_NOT_SIT_TOGETHER" | "PREFER_NEAR" | "AVOID";

// TS-43: the plan-review status workflow's own status values (REQ-PLAN-REVIEW-STATUS).
export type PlanVersionStatus = "DRAFT" | "IN_REVIEW" | "APPROVED";

export interface PlanVersionAssignment {
  id: string;
  guestId: string;
  guestName: string;
  tableId: string;
  tableLabel: string;
  needsReassignment: boolean;
}

export interface ModifiedSinceApproval {
  active: boolean;
  firstModifiedAt: string | null;
  latestModifiedAt: string | null;
}

export interface PlanVersionDetail {
  id: string;
  weddingId: string;
  versionNumber: number;
  label: string | null;
  status: PlanVersionStatus;
  isComplete: boolean;
  isCurrent: boolean;
  revision: number;
  assignments: PlanVersionAssignment[];
  unassignedGuestIds: string[];
  warnings: string[];
  modifiedSinceApproval: ModifiedSinceApproval;
  // TS-47 (FR-9.4): set only on a version created by restoring an earlier one.
  restoredFromVersionNumber: number | null;
}

// TS-47 (Export & Print / Version Restore, FR-9.4): one row of GET .../plan-versions -- the
// wedding's whole version history, newest first, without any one version's own assignment detail.
export interface PlanVersionRow {
  id: string;
  weddingId: string;
  versionNumber: number;
  label: string | null;
  status: PlanVersionStatus;
  isComplete: boolean;
  approvedAt: string | null;
  createdAt: string;
  revision: number;
  isCurrent: boolean;
  assignedGuestCount: number;
  unassignedGuestCount: number;
  restoredFromVersionNumber: number | null;
}

// TS-47 (FR-9.4): the dry-run result GET .../restore-preview returns -- exactly what restoring
// this version would produce against *current* guests/tables/rules, without writing anything.
export interface RestorePreview {
  sourceVersionNumber: number;
  keptCount: number;
  droppedGuests: { guestId: string; guestName: string; reason: string }[];
  unassignedGuestIds: string[];
  isComplete: boolean;
  warnings: string[];
}

// TS-42/TS-43: the two collaborator-model enums (FR-1.4) -- permission level (what a
// collaborator can do) and role (read only for plan-approval authority, FR-6.4).
export type CollaboratorPermission = "VIEW" | "COMMENT" | "EDIT";
export type CollaboratorRole = "COUPLE" | "COLLABORATOR";

export interface CreatedCollaborator {
  id: string;
  userId: string;
  userEmail: string;
  role: CollaboratorRole;
  permissionLevel: CollaboratorPermission;
}

export type CommentTargetType = "GUEST" | "TABLE" | "TIMELINE_ENTRY";

export interface CreateCommentInput {
  targetType: CommentTargetType;
  guestId?: string | null;
  tableId?: string | null;
  timelineEntryId?: string | null;
  body: string;
  parentCommentId?: string | null;
}

export interface CreatedComment {
  id: string;
  targetLabel: string;
  body: string;
  authorUserId: string;
  authorName: string;
  parentCommentId: string | null;
  resolvedAt: string | null;
}

// TS-44 (FR-10.1): one row of the wedding-wide activity/change-history log
// (GET .../activity) -- read directly from packages/db/src/queries/activity.ts's
// `listActivityForWedding`, which joins change_history_entries to plan_versions (for
// versionNumber) and to users (for actorName, left-joined since an actor could in principle be
// gone). `action` is a free-form string column; TS-44 only ever needs to check for
// `"MANUAL_MOVE"`.
export interface ActivityEntry {
  id: string;
  planVersionId: string;
  versionNumber: number;
  action: string;
  description: string;
  actorUserId: string;
  actorName: string | null;
  createdAt: string;
}

// TS-46 (Day-Of Timeline / Run-of-Show, FR-13.1/FR-13.2): a per-wedding, chronological schedule of
// day-of events -- its own record, entirely independent of guests/tables/rules/plan versions.
export interface TimelineEntryDetail {
  id: string;
  weddingId: string;
  time: string;
  description: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

async function assertOk(res: { ok(): boolean; status(): number; text(): Promise<string> }, action: string) {
  if (!res.ok()) {
    throw new Error(`${action} failed: HTTP ${res.status()} — ${await res.text()}`);
  }
}

export class WeddingDataSetup {
  /**
   * TS-102: every wedding created through this helper, so the `weddingData` fixture can delete
   * them all on teardown without each test having to remember a `try/finally`.
   *
   * The `managedWedding` fixture only ever covers the one wedding it creates; tests that need a
   * second wedding (isolation, portfolio, cross-contamination scenarios) previously had no
   * cleanup at all, which is how the dev database accumulated hundreds of stale rows. Tracking
   * here makes cleanup structural -- a test gets it by using the helper, not by remembering to.
   *
   * The globalTeardown sweep remains the backstop for anything this misses (a crashed worker, a
   * wedding created outside this helper entirely); this keeps the database from growing *during*
   * a run rather than only after it.
   */
  private readonly trackedWeddingIds = new Set<string>();

  constructor(private readonly request: APIRequestContext) {}

  /**
   * Register a wedding this helper did not itself create -- one made through the UI (a
   * dashboard-page create, where creating via the UI is the thing under test) or through a raw
   * POST the test needs the response of -- so it is cleaned up on the same teardown path.
   */
  trackWedding(weddingId: string): void {
    this.trackedWeddingIds.add(weddingId);
  }

  /** Wedding ids currently awaiting cleanup. Exposed for assertions/diagnostics. */
  get trackedWeddings(): readonly string[] {
    return [...this.trackedWeddingIds];
  }

  /**
   * Deletes every tracked wedding. Never throws: returns whatever failed so the caller (the
   * fixture) can surface it as a warning rather than replacing the test's own result with a
   * teardown error -- same reasoning as the `managedWedding` cleanup-warning attachment.
   */
  async cleanupTrackedWeddings(): Promise<Array<{ weddingId: string; error: string }>> {
    const failures: Array<{ weddingId: string; error: string }> = [];
    for (const weddingId of [...this.trackedWeddingIds]) {
      try {
        await this.deleteWedding(weddingId);
      } catch (err) {
        failures.push({ weddingId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return failures;
  }

  /**
   * TS-102: the catch-all half of per-test cleanup -- deletes every wedding still visible to this
   * test's account, whether or not it was created through this helper.
   *
   * This is what covers weddings created through the UI (a dashboard-page create, where creating
   * via the UI is the behaviour under test) and through raw `context.request.post` calls, neither
   * of which passes through `createWedding` and so neither of which can be tracked.
   *
   * Safe because the account is disposable: `signUpFreshAccount` makes a brand-new account per
   * test, and a brand-new account owns no weddings, so anything this endpoint returns was created
   * during this test. The one exception is a wedding the test was invited to collaborate on --
   * owned by a different (also disposable) account -- and the API refuses that delete with a 403,
   * which is treated as "not mine, leave it alone" rather than a failure.
   */
  async cleanupOwnedWeddings(): Promise<Array<{ weddingId: string; error: string }>> {
    const failures: Array<{ weddingId: string; error: string }> = [];

    let weddings: Array<{ id: string; name: string }>;
    try {
      const res = await this.request.get("/api/v1/weddings");
      if (!res.ok()) return failures; // Session already gone, or the app is down -- nothing to do.
      weddings = ((await res.json()) as { weddings: Array<{ id: string; name: string }> }).weddings;
    } catch {
      return failures;
    }

    for (const wedding of weddings) {
      try {
        const res = await this.request.delete(`/api/v1/weddings/${wedding.id}`);
        // 403: owned by another account (a collaboration) -- not this test's to delete.
        // 404: already gone.
        if (!res.ok() && res.status() !== 403 && res.status() !== 404) {
          failures.push({ weddingId: wedding.id, error: `HTTP ${res.status()} deleting "${wedding.name}"` });
        }
        this.trackedWeddingIds.delete(wedding.id);
      } catch (err) {
        failures.push({ weddingId: wedding.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return failures;
  }

  // TS-51: extended with an optional second argument so template-seeding scenarios can pass
  // templateId/applyTemplateTables/applyTemplateRules/sideMixing without disturbing any existing
  // caller (every prior call site passes only a bare name).
  async createWedding(name: string, options?: CreateWeddingOptions): Promise<CreatedWedding> {
    const res = await this.request.post("/api/v1/weddings", { data: { name, ...options } });
    await assertOk(res, `createWedding("${name}")`);
    const body = (await res.json()) as { wedding: { id: string; name: string } };
    this.trackWedding(body.wedding.id);
    return { id: body.wedding.id, name: body.wedding.name };
  }

  /** TS-51: the raw POST .../weddings response (status + body), for validation-error scenarios --
   * e.g. a templateId with neither apply flag checked, which createWeddingSchema's own superRefine
   * rejects with a 422 -- where the caller wants to inspect that directly rather than have
   * createWedding's assertOk throw on it. */
  async createWeddingRaw(
    input: { name: string } & CreateWeddingOptions,
  ): Promise<{ status: number; body: { wedding?: { id: string; name: string }; error?: string; fieldErrors?: Record<string, string[]> } }> {
    const res = await this.request.post("/api/v1/weddings", { data: input });
    const body = (await res.json()) as { wedding?: { id: string; name: string }; error?: string; fieldErrors?: Record<string, string[]> };
    // TS-102: these calls exist to inspect validation failures, but the ones that *do* succeed
    // create a real wedding that would otherwise leak exactly like any other.
    if (body.wedding?.id) this.trackWedding(body.wedding.id);
    return { status: res.status(), body };
  }

  /** TS-51: the full wedding row (GET .../weddings/:id) -- CreatedWedding only carries id/name. */
  async getWedding(weddingId: string): Promise<WeddingDetail> {
    const res = await this.request.get(`/api/v1/weddings/${weddingId}`);
    await assertOk(res, `getWedding(${weddingId})`);
    const body = (await res.json()) as { wedding: WeddingDetail };
    return body.wedding;
  }

  /** TS-51: GET .../weddings/:id/tables -- the wedding's current table list, in the order the API
   * returns them (insertion order; template-seeded tables have no sortOrder of their own once
   * cloned into real seating_tables rows). */
  async listTables(weddingId: string): Promise<CreatedTableDetail[]> {
    const res = await this.request.get(`/api/v1/weddings/${weddingId}/tables`);
    await assertOk(res, `listTables(${weddingId})`);
    const body = (await res.json()) as { tables: CreatedTableDetail[] };
    return body.tables;
  }

  /** TS-51 (FR-14.1/FR-14.2): POST .../weddings/:id/save-as-template -- snapshots this wedding's
   * current table layout + sideMixing into a brand-new template owned by the caller. */
  async saveWeddingAsTemplate(weddingId: string, name: string): Promise<SeatingTemplateDetail> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/save-as-template`, { data: { name } });
    await assertOk(res, `saveWeddingAsTemplate(${weddingId}, "${name}")`);
    const body = (await res.json()) as { template: SeatingTemplateDetail };
    return body.template;
  }

  /** TS-51: GET /api/v1/templates -- every template owned by the caller (never another user's). */
  async listTemplates(): Promise<SeatingTemplateSummary[]> {
    const res = await this.request.get("/api/v1/templates");
    await assertOk(res, "listTemplates()");
    const body = (await res.json()) as { templates: SeatingTemplateSummary[] };
    return body.templates;
  }

  /** TS-51: the raw GET /api/v1/templates/:id response (status + body) -- used both for the happy
   * path (full detail read) and the ownership-scoping edge case (a 404 for someone else's
   * template), so callers that expect a non-200 don't have to catch assertOk's throw. */
  async getTemplateRaw(templateId: string): Promise<{ status: number; body: { template?: SeatingTemplateDetail; error?: string } }> {
    const res = await this.request.get(`/api/v1/templates/${templateId}`);
    return { status: res.status(), body: await res.json() };
  }

  /** TS-51: the raw DELETE /api/v1/templates/:id response (status + body) -- same rationale as
   * getTemplateRaw (a non-owner's delete attempt is a 404, not a thrown assertion failure). */
  async deleteTemplateRaw(templateId: string): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
    const res = await this.request.delete(`/api/v1/templates/${templateId}`);
    return { status: res.status(), body: await res.json() };
  }

  async createGuest(weddingId: string, input: CreateGuestInput): Promise<CreatedGuest> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/guests`, { data: input });
    await assertOk(res, `createGuest("${input.firstName} ${input.lastName}")`);
    const body = (await res.json()) as {
      guest: { id: string; firstName: string; lastName: string };
    };
    return body.guest;
  }

  /** TS-38: creates a batch of identical tables in one call, via the same "12 round tables of 8"
   * quick-create endpoint the Tables tab's own UI uses (`POST .../tables/quick-create`). */
  async quickCreateTables(weddingId: string, input: QuickCreateTablesInput): Promise<CreatedTable[]> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/tables/quick-create`, { data: input });
    await assertOk(res, `quickCreateTables(${JSON.stringify(input)})`);
    const body = (await res.json()) as { tables: CreatedTable[] };
    return body.tables;
  }

  /** TS-54: creates one table with specific flags (isRestricted/isAccessible), via the plain
   * table-creation endpoint (POST .../tables) rather than the identical-batch quick-create one. */
  async createTable(weddingId: string, input: CreateTableInput): Promise<CreatedTableDetail> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/tables`, { data: input });
    await assertOk(res, `createTable("${input.label}")`);
    const body = (await res.json()) as { table: CreatedTableDetail };
    return body.table;
  }

  /** TS-42: updates a table's fields (PATCH .../tables/:tableId) -- e.g. toggling
   * singleSideOnly/purposeCriterionType/isRestricted/isAccessible on a table that already
   * exists, rather than only being able to set flags at creation time. */
  async updateTable(weddingId: string, tableId: string, input: UpdateTableInput): Promise<CreatedTableDetail> {
    const res = await this.request.patch(`/api/v1/weddings/${weddingId}/tables/${tableId}`, { data: input });
    await assertOk(res, `updateTable(${tableId}, ${JSON.stringify(input)})`);
    const body = (await res.json()) as { table: CreatedTableDetail };
    return body.table;
  }

  /** TS-54: replaces a Restricted table's entire required-guest list (PUT .../required-guests) --
   * the only hard-rule fixture setup a manual-move test needs beyond a plain guest/table/rule. */
  async setRequiredGuests(weddingId: string, tableId: string, guestIds: string[]): Promise<void> {
    const res = await this.request.put(`/api/v1/weddings/${weddingId}/tables/${tableId}/required-guests`, {
      data: { guestIds },
    });
    await assertOk(res, `setRequiredGuests(${tableId}, [${guestIds.join(", ")}])`);
  }

  /** TS-38: creates a seating rule between two guests (must/must-not sit together, prefer near,
   * avoid) -- the seat-assignment engine's own rule input. */
  async createRelationship(
    weddingId: string,
    guestAId: string,
    guestBId: string,
    type: RelationshipType,
  ): Promise<{ id: string }> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/relationships`, {
      data: { guestAId, guestBId, type },
    });
    await assertOk(res, `createRelationship(${guestAId}, ${guestBId}, ${type})`);
    const body = (await res.json()) as { relationship: { id: string } };
    return body.relationship;
  }

  /** TS-42: deletes a single seating rule (DELETE .../relationships/:relationshipId) -- a rule
   * can only ever be added or removed (there's no edit verb), so this is the only mutation
   * beyond createRelationship a rules-list test needs. A 404 is treated as already-gone. */
  async deleteRelationship(weddingId: string, relationshipId: string): Promise<void> {
    const res = await this.request.delete(`/api/v1/weddings/${weddingId}/relationships/${relationshipId}`);
    if (!res.ok() && res.status() !== 404) {
      await assertOk(res, `deleteRelationship(${relationshipId})`);
    }
  }

  /** TS-42: updates wedding-level settings (PATCH .../weddings/:weddingId) -- currently only
   * needed for sideMixing, which has no UI control at all (see RulesTab/TablesTab investigation
   * notes); OWNER-only access, which the managedWedding fixture's own account always has. */
  async updateWedding(weddingId: string, input: { sideMixing?: "KEEP_SEPARATE" | "BALANCED_MIX" | "FULLY_MIXED" }): Promise<void> {
    const res = await this.request.patch(`/api/v1/weddings/${weddingId}`, { data: input });
    await assertOk(res, `updateWedding(${weddingId}, ${JSON.stringify(input)})`);
  }

  /** TS-43: runs one generation (POST .../plan-versions/generate). Thin wrapper -- the existing
   * seat-assignment/access-control tests call this raw, but TS-43's plan-review-status tests need
   * it repeatedly across several files, so it's centralized here rather than copy-pasted. */
  async generatePlanVersion(weddingId: string): Promise<PlanVersionDetail> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/plan-versions/generate`);
    await assertOk(res, `generatePlanVersion(${weddingId})`);
    const body = (await res.json()) as { planVersion: PlanVersionDetail };
    return body.planVersion;
  }

  /** TS-43: reads a single plan version's full detail (GET .../plan-versions/:id), including
   * status, assignments (each with needsReassignment), unassignedGuestIds, and
   * modifiedSinceApproval (FR-6.6). */
  async getPlanVersionDetail(weddingId: string, planVersionId: string): Promise<PlanVersionDetail> {
    const res = await this.request.get(`/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}`);
    await assertOk(res, `getPlanVersionDetail(${planVersionId})`);
    const body = (await res.json()) as { planVersion: PlanVersionDetail };
    return body.planVersion;
  }

  /** TS-43 (FR-6.4): moves the Current Plan Version between DRAFT/IN_REVIEW/APPROVED
   * (POST .../plan-versions/:id/status). Returns the raw response rather than asserting success,
   * since several TS-43 tests specifically need to inspect a 403/409 rather than treat it as a
   * setup failure. */
  async setPlanVersionStatus(
    weddingId: string,
    planVersionId: string,
    status: PlanVersionStatus,
    expectedRevision?: number,
  ): Promise<{ status: number; body: { planVersion?: PlanVersionDetail; error?: string } }> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}/status`, {
      data: { status, expectedRevision },
    });
    return { status: res.status(), body: await res.json() };
  }

  /** TS-43 (FR-7.2/FR-7.3): moves one guest to a different table within the Current Plan Version
   * (POST .../plan-versions/:id/assignments). Same not-asserting-success shape as
   * setPlanVersionStatus, for the same reason -- permission-denial tests need the raw response. */
  async moveGuestAssignment(
    weddingId: string,
    planVersionId: string,
    guestId: string,
    tableId: string | null,
    expectedRevision?: number,
  ): Promise<{ status: number; body: { planVersion?: PlanVersionDetail; warnings?: string[]; error?: string } }> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}/assignments`, {
      data: { guestId, tableId, expectedRevision },
    });
    return { status: res.status(), body: await res.json() };
  }

  /** TS-43 (FR-1.4): directly grants an already-registered account collaborator access
   * (POST .../collaborators) -- the route's own comment describes this as "fast test/setup
   * scaffolding" alongside the real invite/accept flow, which is exactly what it's used for here. */
  async addCollaborator(
    weddingId: string,
    email: string,
    permissionLevel: CollaboratorPermission,
    role: CollaboratorRole = "COLLABORATOR",
  ): Promise<CreatedCollaborator> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/collaborators`, {
      data: { email, permissionLevel, role },
    });
    await assertOk(res, `addCollaborator(${email}, ${permissionLevel}, ${role})`);
    const body = (await res.json()) as { collaborator: CreatedCollaborator };
    return body.collaborator;
  }

  /** TS-43 (FR-10.3): posts a comment on a guest, table, or timeline entry
   * (POST .../comments). Returns the raw response (not asserting success) since permission-denial
   * (View can't comment) is itself part of what TS-43 tests. */
  async postComment(
    weddingId: string,
    input: CreateCommentInput,
  ): Promise<{ status: number; body: { comment?: CreatedComment; error?: string } }> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/comments`, { data: input });
    return { status: res.status(), body: await res.json() };
  }

  /** TS-43 (FR-10.3): resolves a comment thread (POST .../comments/:id/resolve) -- only the
   * original author or an Edit-level collaborator may succeed; same raw-response shape as
   * postComment for the same reason. */
  async resolveComment(
    weddingId: string,
    commentId: string,
  ): Promise<{ status: number; body: { comment?: CreatedComment; error?: string } }> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/comments/${commentId}/resolve`);
    return { status: res.status(), body: await res.json() };
  }

  /** TS-45 (Day-Of Mode, FR-8.1): flips a guest's same-day attendance signal
   * (POST .../guests/:guestId/attendance) -- acts on whichever plan version is Current, not a
   * specific one, and frees/leaves-unassigned a seat without any regeneration. Returns the raw
   * response (not asserting success) since a couple of TS-45 tests read the `planVersion` field
   * directly off a 200 rather than needing a separate detail fetch. */
  async setAttendance(
    weddingId: string,
    guestId: string,
    attendance: "ATTENDING" | "NOT_ATTENDING",
  ): Promise<{ status: number; body: { planVersion?: PlanVersionDetail | null; error?: string } }> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/guests/${guestId}/attendance`, {
      data: { attendance },
    });
    return { status: res.status(), body: await res.json() };
  }

  /** TS-45 (Day-Of Mode, FR-8.1): swaps two already-seated guests' (or their forced-together
   * units') tables in one atomic move (POST .../plan-versions/:id/assignments/swap). Same raw
   * {status, body} shape as moveGuestAssignment, for the same reason -- several TS-45 tests need
   * to inspect a specific 409 rather than treat it as a setup failure. */
  async swapGuestAssignments(
    weddingId: string,
    planVersionId: string,
    guestAId: string,
    guestBId: string,
    expectedRevision?: number,
  ): Promise<{ status: number; body: { planVersion?: PlanVersionDetail; warnings?: string[]; error?: string } }> {
    const res = await this.request.post(
      `/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}/assignments/swap`,
      { data: { guestAId, guestBId, expectedRevision } },
    );
    return { status: res.status(), body: await res.json() };
  }

  /** TS-44 (FR-10.1): reads the wedding's whole chronological change-history/activity log
   * (GET .../activity) -- used to confirm a manual move recorded a MANUAL_MOVE entry naming who
   * made it and when, without needing any UI (there's no dedicated Activity-tab page object; the
   * feed itself is the only thing under test here). */
  async getActivity(weddingId: string): Promise<ActivityEntry[]> {
    const res = await this.request.get(`/api/v1/weddings/${weddingId}/activity`);
    await assertOk(res, `getActivity(${weddingId})`);
    const body = (await res.json()) as { entries: ActivityEntry[] };
    return body.entries;
  }

  /** TS-46 (Day-Of Timeline, FR-13.1): creates one run-of-show entry
   * (POST .../timeline-entries). Returns the raw {status, body} rather than asserting success,
   * since a schema-invalid `time` string (rejected 422) is itself one of this story's own test
   * cases, not a setup failure. */
  async createTimelineEntry(
    weddingId: string,
    input: { time: string; description: string },
  ): Promise<{ status: number; body: { entry?: TimelineEntryDetail; error?: string } }> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/timeline-entries`, { data: input });
    return { status: res.status(), body: await res.json() };
  }

  /** TS-46: reads the wedding's full run-of-show (GET .../timeline-entries), already ordered
   * (time, sortOrder) exactly as the Timeline tab's own UI lists it -- confirmed directly in
   * packages/db/src/queries/timeline.ts's `listTimelineEntriesForWedding`. */
  async getTimelineEntries(weddingId: string): Promise<TimelineEntryDetail[]> {
    const res = await this.request.get(`/api/v1/weddings/${weddingId}/timeline-entries`);
    await assertOk(res, `getTimelineEntries(${weddingId})`);
    const body = (await res.json()) as { entries: TimelineEntryDetail[] };
    return body.entries;
  }

  /** TS-46: edits an entry's time and/or description (PATCH .../timeline-entries/:entryId). Raw
   * {status, body} for the same reason as createTimelineEntry. */
  async updateTimelineEntry(
    weddingId: string,
    entryId: string,
    input: Partial<{ time: string; description: string }>,
  ): Promise<{ status: number; body: { entry?: TimelineEntryDetail; error?: string } }> {
    const res = await this.request.patch(`/api/v1/weddings/${weddingId}/timeline-entries/${entryId}`, {
      data: input,
    });
    return { status: res.status(), body: await res.json() };
  }

  /** TS-46 (FR-13.2): moves one entry earlier/later among any others sharing its exact same
   * `time` (POST .../timeline-entries/:entryId/reorder). Raw {status, body} since a
   * no-eligible-neighbor no-op (still 200, entry unchanged) is itself one of this story's own
   * assertions, not a setup failure. */
  async reorderTimelineEntry(
    weddingId: string,
    entryId: string,
    direction: "UP" | "DOWN",
  ): Promise<{ status: number; body: { entry?: TimelineEntryDetail; error?: string } }> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/timeline-entries/${entryId}/reorder`, {
      data: { direction },
    });
    return { status: res.status(), body: await res.json() };
  }

  /** TS-46: removes one entry (DELETE .../timeline-entries/:entryId). Raw {status, body} so a
   * delete-of-an-already-gone entry (404) can be asserted rather than treated as a failure. */
  async deleteTimelineEntry(weddingId: string, entryId: string): Promise<{ status: number; body: unknown }> {
    const res = await this.request.delete(`/api/v1/weddings/${weddingId}/timeline-entries/${entryId}`);
    return { status: res.status(), body: await res.json().catch(() => null) };
  }

  /** TS-47 (Export & Print / Version Restore, FR-9.4): lists every plan version for the wedding,
   * newest first (GET .../plan-versions) -- each row carries its own `restoredFromVersionNumber`
   * (set only on a version created by restoring an earlier one) and `revision`, which a restore
   * test uses to confirm untouched versions are byte-for-byte unchanged afterward. */
  async listPlanVersions(weddingId: string): Promise<PlanVersionRow[]> {
    const res = await this.request.get(`/api/v1/weddings/${weddingId}/plan-versions`);
    await assertOk(res, `listPlanVersions(${weddingId})`);
    const body = (await res.json()) as { planVersions: PlanVersionRow[] };
    return body.planVersions;
  }

  /** TS-47 (FR-9.4): a read-only dry run of restoring `planVersionId` (GET .../restore-preview) --
   * computes kept-vs-dropped-vs-warned against *current* guests/tables/rules without writing
   * anything. Raw {status, body} since View-vs-denied access is itself one of this story's own
   * test cases. */
  async previewRestore(
    weddingId: string,
    planVersionId: string,
  ): Promise<{ status: number; body: { preview?: RestorePreview; error?: string } }> {
    const res = await this.request.get(`/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}/restore-preview`);
    return { status: res.status(), body: await res.json() };
  }

  /** TS-47 (FR-9.4): commits a restore (POST .../restore) -- copies `planVersionId`'s own
   * assignments into a brand-new version (re-validated against current data) that becomes
   * Current; the source version and everything else in the history are left untouched. Raw
   * {status, body} for the same reason as previewRestore. */
  async restoreVersion(
    weddingId: string,
    planVersionId: string,
  ): Promise<{ status: number; body: { planVersion?: PlanVersionDetail; warnings?: string[]; error?: string } }> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}/restore`);
    return { status: res.status(), body: await res.json() };
  }

  /** Deletes a single guest. Supported by the app's API (DELETE
   * /api/v1/weddings/:weddingId/guests/:guestId) — included for completeness, though
   * `deleteWedding` alone is enough to clean up everything a test created under it. */
  async deleteGuest(weddingId: string, guestId: string): Promise<void> {
    const res = await this.request.delete(`/api/v1/weddings/${weddingId}/guests/${guestId}`);
    if (!res.ok() && res.status() !== 404) {
      await assertOk(res, `deleteGuest(${guestId})`);
    }
  }

  /** Deletes a wedding and (per the app's own cascade) everything created under it — tables,
   * guests, rules, plan versions. A 404 is treated as already-clean, not a failure. TS-51 also
   * reuses this directly to prove a template outlives its source wedding (the FK is
   * ON DELETE SET NULL, not a cascade, onto the template itself). */
  async deleteWedding(weddingId: string): Promise<void> {
    const res = await this.request.delete(`/api/v1/weddings/${weddingId}`);
    if (!res.ok() && res.status() !== 404) {
      await assertOk(res, `deleteWedding(${weddingId})`);
    }
    // TS-102: a wedding the test deleted itself no longer needs cleaning up on teardown. A 404 is
    // treated the same way -- it is already gone.
    this.trackedWeddingIds.delete(weddingId);
  }

  /**
   * Explicit unsupported state (spec Stage 03 task, verbatim): the app exposes no endpoint to
   * delete a user account (checked directly against the API route tree — there is no
   * `/api/v1/users` or account-deletion route of any kind as of Stage 03). Every account this
   * framework's auth fixture signs up therefore persists in the target database indefinitely;
   * this method exists so that fact is a loud, documented limitation instead of a silent no-op a
   * future maintainer has to rediscover by noticing the user table keeps growing.
   */
  async deleteUserAccount(): Promise<never> {
    throw new UnsupportedCleanupError(
      "The application has no account-deletion endpoint. Test-created user accounts are not " +
        "cleaned up and will accumulate in the target database — see DEC-012 in " +
        "PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md.",
    );
  }
}
