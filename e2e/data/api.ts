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

async function assertOk(res: { ok(): boolean; status(): number; text(): Promise<string> }, action: string) {
  if (!res.ok()) {
    throw new Error(`${action} failed: HTTP ${res.status()} — ${await res.text()}`);
  }
}

export class WeddingDataSetup {
  constructor(private readonly request: APIRequestContext) {}

  async createWedding(name: string): Promise<CreatedWedding> {
    const res = await this.request.post("/api/v1/weddings", { data: { name } });
    await assertOk(res, `createWedding("${name}")`);
    const body = (await res.json()) as { wedding: { id: string; name: string } };
    return { id: body.wedding.id, name: body.wedding.name };
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
   * guests, rules, plan versions. A 404 is treated as already-clean, not a failure. */
  async deleteWedding(weddingId: string): Promise<void> {
    const res = await this.request.delete(`/api/v1/weddings/${weddingId}`);
    if (!res.ok() && res.status() !== 404) {
      await assertOk(res, `deleteWedding(${weddingId})`);
    }
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
