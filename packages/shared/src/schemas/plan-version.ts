import { z } from "zod";
import { FIELD_LIMITS } from "../field-limits";
import { expectedRevisionField } from "./common";
import type { SideMixing } from "./wedding";

export type PlanVersionStatusValue = "DRAFT" | "IN_REVIEW" | "APPROVED";

// FR-7.7: every plan-version write accepts the revision the client last saw, so the server can
// detect a save that landed on top of a newer one instead of silently overwriting it.
// TS-174: bounded to what the database can store (see ./common).

export const planVersionStatusSchema = z.object({
  status: z.enum(["DRAFT", "IN_REVIEW", "APPROVED"]),
  expectedRevision: expectedRevisionField,
});

// FR-9.4/TS-10: a plan version's label is a free-text nickname ("Family-approved draft",
// "Post-RSVP final") to tell versions apart at a glance beyond the auto-incrementing number.
// Empty string clears the label back to none.
export const setPlanVersionLabelSchema = z.object({
  label: z.string().trim().max(FIELD_LIMITS.planVersionLabel),
  expectedRevision: expectedRevisionField,
});
export type SetPlanVersionLabelInput = z.infer<typeof setPlanVersionLabelSchema>;

export interface ModifiedSinceApprovalDTO {
  active: boolean;
  firstModifiedAt: string | null;
  latestModifiedAt: string | null;
}

export interface PlanVersionDTO {
  id: string;
  weddingId: string;
  versionNumber: number;
  label: string | null;
  status: PlanVersionStatusValue;
  isComplete: boolean;
  approvedAt: string | null;
  isCurrent: boolean;
  createdAt: string;
  assignedGuestCount: number;
  unassignedGuestCount: number;
  // FR-9.4: set when this version was created by restoring an earlier one.
  restoredFromVersionNumber: number | null;
  // FR-3.4 AC: the wedding's Side-Mixing setting and the soft-rule weighting-config version in
  // effect when this version was generated — null on a version created before this existed.
  sideMixingSetting: SideMixing | null;
  ruleConfigVersion: number | null;
  // FR-7.7: an optimistic-concurrency counter — send this back as expectedRevision on a write to
  // this version so the server can detect and refuse a save based on stale data.
  revision: number;
}

export interface PlanVersionAssignmentDTO {
  id: string;
  guestId: string;
  guestName: string;
  tableId: string;
  tableLabel: string;
  needsReassignment: boolean;
  /** TS-221: an older version's seat held by a guest since marked not attending. */
  notAttending?: boolean;
}

export interface PlanVersionDetailDTO extends PlanVersionDTO {
  assignments: PlanVersionAssignmentDTO[];
  unassignedGuestIds: string[];
  /** TS-207: the unassigned guests' names (a guest added on another screen may not be in this
   * screen's guest list yet). */
  unassignedGuests?: { id: string; name: string }[];
  warnings: string[];
  modifiedSinceApproval: ModifiedSinceApprovalDTO;
}

// FR-5.6: the planner's upfront choice of whether a successful generation becomes the new
// Current version (replacing whichever was Current before) or a non-replacing Comparison Draft.
// Defaults to true so existing callers that don't send a body keep the old "always current"
// behavior.
export const generatePlanVersionSchema = z.object({
  makeCurrent: z.boolean().optional(),
});
export type GeneratePlanVersionInput = z.infer<typeof generatePlanVersionSchema>;

// FR-5.3: one PREFER_NEAR or AVOID relationship's outcome in the generated plan.
export interface SoftPreferenceEntryDTO {
  type: "PREFER_NEAR" | "AVOID";
  guestAId: string;
  guestAName: string;
  guestBId: string;
  guestBName: string;
  satisfied: boolean;
}

// FR-3.7/FR-5.3: a Purpose table's wedding-wide match rate.
export interface PurposeTableScoreEntryDTO {
  tableId: string;
  tableLabel: string;
  criterionType: "SIDE" | "TIER" | "AGE_CATEGORY";
  criterionValue: string;
  matchingGuestsSeatedHere: number;
  matchingGuestsTotal: number;
}

// FR-3.4/FR-5.3: Side-Mixing is scored per table, so it's reported as an aggregate.
export interface SideMixingScoreReportDTO {
  setting: SideMixing;
  mixedTableCount: number;
  singleSideTableCount: number;
  singleSideOnlyViolations: number;
}

// FR-5.3: "generation ... reports which preferences were satisfied/unsatisfied and the
// weighting-configuration version used; any displayed score links to its calculation method" --
// the calculation method itself is RULE_WEIGHT_CONFIG (packages/shared/src/seating-engine.ts),
// exported alongside this report's own ruleConfigVersion so the UI can show the exact weights
// that produced it without a second round-trip.
export interface PlanVersionScoreReportDTO {
  ruleConfigVersion: number;
  totalScore: number;
  preferences: SoftPreferenceEntryDTO[];
  purposeTables: PurposeTableScoreEntryDTO[];
  sideMixing: SideMixingScoreReportDTO;
}

export interface GeneratePlanResponse {
  planVersion: PlanVersionDetailDTO;
  errors: string[];
  scoreReport?: PlanVersionScoreReportDTO;
}

export const moveGuestAssignmentSchema = z.object({
  guestId: z.string().min(1),
  // FR-7.5: undo/redo of "assign a previously unassigned guest" needs a way to put a guest back
  // to unassigned -- tableId: null means exactly that (never exposed as a manual "unassign"
  // button; only the undo/redo stack calls it directly today).
  tableId: z.string().min(1).nullable(),
  expectedRevision: expectedRevisionField,
  // TS-208: with tableId null, unseat only these members of the guest's must-sit-together group
  // (undo of seating a guest whose partner was already at that table keeps the partner seated).
  onlyGuestIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  // TS-228: sent by Undo when it puts a group back at a table -- where each member of the guest's
  // must-sit-together group (as the screen saw it) sat before the move being undone. The server
  // works the group out again under the plan's lock and refuses (UNDO_SPLITS_GROUP_MESSAGE) if
  // anyone in it wasn't at that table then -- e.g. a must-sit rule added a moment before the undo.
  undoSeatsBefore: z
    .record(z.string().min(1).max(64), z.string().min(1).max(64))
    .refine((seats) => Object.keys(seats).length <= 500, "Too many seats.")
    .optional(),
});
export type MoveGuestAssignmentInput = z.infer<typeof moveGuestAssignmentSchema>;

/** TS-221: what Undo says when putting the move back would split a must-sit-together group. */
export const UNDO_SPLITS_GROUP_MESSAGE = "Can't undo — that would split a must-sit-together group.";

/**
 * TS-221 / TS-228: true when sending `group` (everyone who moves together) to `undoTableId` would
 * put someone at a table they weren't at before the move -- the group was split then, so moving it
 * back together isn't an undo. `seatsBefore`: guest id -> table before the move (unseated: absent).
 * Used by the Seating plan tab and again by the server, under the plan's lock.
 */
export function undoSplitsGroup(group: readonly string[], seatsBefore: Readonly<Record<string, string>>, undoTableId: string): boolean {
  return group.some((g) => (Object.prototype.hasOwnProperty.call(seatsBefore, g) ? seatsBefore[g] : null) !== undoTableId);
}

// FR-8.1 (Day-Of Mode): swap two guests' (or their forced-together units') tables in one move.
export const swapGuestAssignmentsSchema = z.object({
  guestAId: z.string().min(1),
  guestBId: z.string().min(1),
  expectedRevision: expectedRevisionField,
});
export type SwapGuestAssignmentsInput = z.infer<typeof swapGuestAssignmentsSchema>;

// FR-8.1: flip a guest's same-day attendance signal (independent of rsvpStatus).
export const setAttendanceSchema = z.object({
  attendance: z.enum(["ATTENDING", "NOT_ATTENDING"]),
});
export type SetAttendanceInput = z.infer<typeof setAttendanceSchema>;

// FR-9.4: what restoring a prior version would do, computed against current data without
// writing anything — meant to be shown to the user before they confirm the actual restore.
export interface RestorePreviewDTO {
  sourceVersionNumber: number;
  keptCount: number;
  droppedGuests: { guestId: string; guestName: string; reason: string }[];
  unassignedGuestIds: string[];
  isComplete: boolean;
  // TS-177: of keptCount, how many will be flagged Needs Reassignment once restored.
  needsFixingCount: number;
  warnings: string[];
}

// Version labeling + comparison (TS-10/TS-12): compare any two of a wedding's plan versions
// guest-by-guest. "moved" means seated at a different table in each version; "added"/"removed"
// means seated in one version but not the other (e.g. attendance changed between versions);
// "unchanged" means the same table in both.
export type GuestComparisonStatus = "unchanged" | "moved" | "added" | "removed";

export interface GuestComparisonEntryDTO {
  guestId: string;
  guestName: string;
  fromTableId: string | null;
  fromTableLabel: string | null;
  toTableId: string | null;
  toTableLabel: string | null;
  status: GuestComparisonStatus;
  /** TS-235: set (true) when the guest is marked not attending now -- left out of the summary counts. */
  notAttending?: true;
}

export interface PlanVersionComparisonSummaryRefDTO {
  id: string;
  versionNumber: number;
  label: string | null;
  createdAt: string;
}

export interface PlanVersionComparisonDTO {
  from: PlanVersionComparisonSummaryRefDTO;
  to: PlanVersionComparisonSummaryRefDTO;
  guests: GuestComparisonEntryDTO[];
  // TS-235: guests not attending now aren't counted.
  summary: {
    movedCount: number;
    addedCount: number;
    removedCount: number;
    unchangedCount: number;
  };
}
