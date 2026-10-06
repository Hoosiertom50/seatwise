import { z } from "zod";
// TS-180: free text refuses hidden control characters (see ../safe-text).
import { safeText } from "../safe-text";
import { expectedRevisionField } from "./common";
import { guestSideEnum, guestTierEnum, ageCategoryEnum } from "./guest";

// FR-4.1: affects only the floor-plan drawing (FR-4.3), never seating logic.
export const tableShapeEnum = z.enum(["ROUND", "RECTANGULAR", "SQUARE", "OVAL", "OTHER"]);
export type TableShape = z.infer<typeof tableShapeEnum>;

// FR-3.7: a Purpose table's structured criterion -- on top of the free-text `purpose` label
// below, which has no algorithmic effect on its own. Always a soft preference for generation.
export const tablePurposeCriterionTypeEnum = z.enum(["SIDE", "TIER", "AGE_CATEGORY"]);
export type TablePurposeCriterionType = z.infer<typeof tablePurposeCriterionTypeEnum>;

function criterionValueOptions(type: TablePurposeCriterionType): readonly string[] {
  switch (type) {
    case "SIDE":
      return guestSideEnum.options;
    case "TIER":
      return guestTierEnum.options;
    case "AGE_CATEGORY":
      return ageCategoryEnum.options;
  }
}

// FR-3.7: purposeCriterionType and purposeCriterionValue are always set (or cleared) together --
// a partial update can't safely infer one from the other, so the API requires both in the same
// request whenever either changes, rather than guessing at what the existing value means.
function validatePurposeCriterion(
  data: { purposeCriterionType?: TablePurposeCriterionType | null; purposeCriterionValue?: string | null },
  ctx: z.RefinementCtx
) {
  const { purposeCriterionType: type, purposeCriterionValue: value } = data;
  if (type === undefined && value === undefined) return;
  if (!type) {
    if (value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A purpose criterion value can't be set without a type.",
        path: ["purposeCriterionValue"],
      });
    }
    return;
  }
  if (!value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A purpose criterion type needs a value.",
      path: ["purposeCriterionValue"],
    });
    return;
  }
  const allowed = criterionValueOptions(type);
  if (!allowed.includes(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"${value}" isn't a valid value for a ${type} criterion (expected one of ${allowed.join(", ")}).`,
      path: ["purposeCriterionValue"],
    });
  }
}

const tableBaseSchema = z.object({
  label: safeText(100, { required: "Table name is required" }),
  capacity: z.number().int().min(1).max(50),
  isRestricted: z.boolean().default(false),
  isAccessible: z.boolean().default(false),
  isLocked: z.boolean().default(false),
  purpose: safeText(200).optional().nullable(),
  purposeCriterionType: tablePurposeCriterionTypeEnum.optional().nullable(),
  purposeCriterionValue: safeText(40).optional().nullable(),
  // FR-3.4: table-level override, favoring one side only regardless of the wedding's setting.
  singleSideOnly: z.boolean().default(false),
  shape: tableShapeEnum.default("ROUND"),
});

export const createTableSchema = tableBaseSchema.superRefine(validatePurposeCriterion);
export type CreateTableInput = z.infer<typeof tableBaseSchema>;

// FR-7.7, extended to seating tables: every edit accepts the revision the client last saw, so the
// server can detect a save that landed on top of a newer one instead of silently overwriting it.
// TS-174: bounded to what the database can store (see ./common).

export const updateTableSchema = tableBaseSchema
  .partial()
  .extend({
    // FR-4.3: the floor plan's drag position. Nullable -- a table that's never been placed on the
    // floor plan has no position, and the UI falls back to a client-computed grid slot purely for
    // display (never persisted) until the user actually drags it. Position is display-only: it's
    // never read by generation, the engine, or any rule check.
    positionX: z.number().finite().nullable().optional(),
    positionY: z.number().finite().nullable().optional(),
    expectedRevision: expectedRevisionField,
    // TS-120: a Restricted table's required-guest list, saved in the same edit as the table's
    // other fields so current seating is re-checked once, against the final state.
    requiredGuestIds: z.array(z.string()).max(50).optional(),
  })
  .superRefine(validatePurposeCriterion);
export type UpdateTableInput = z.infer<typeof updateTableSchema>;

// FR-4.2: create a standard set of same-shape, same-capacity tables in one action (e.g. "12 round
// tables of 8"). Distinct labels are assigned automatically, continuing after any tables that
// already exist so a repeated quick-create never collides with earlier ones.
export const quickCreateTablesSchema = z.object({
  count: z.number().int().min(1).max(100),
  capacity: z.number().int().min(1).max(50),
  shape: tableShapeEnum.default("ROUND"),
  labelPrefix: safeText(50, { required: "A name for the tables is required" }).default("Table"),
});
export type QuickCreateTablesInput = z.infer<typeof quickCreateTablesSchema>;

// FR-3.7a: replaces a Restricted table's entire required-guest list in one call (so an
// over-capacity or conflicting list is validated and rejected atomically, never partially saved).
export const setRequiredGuestsSchema = z.object({
  guestIds: z.array(z.string().min(1)).max(50),
});
export type SetRequiredGuestsInput = z.infer<typeof setRequiredGuestsSchema>;

export interface SeatingTableDTO {
  id: string;
  weddingId: string;
  label: string;
  capacity: number;
  isRestricted: boolean;
  isAccessible: boolean;
  isLocked: boolean;
  purpose: string | null;
  // FR-3.7
  purposeCriterionType: TablePurposeCriterionType | null;
  purposeCriterionValue: string | null;
  // FR-3.4
  singleSideOnly: boolean;
  // FR-4.1
  shape: TableShape;
  // FR-4.3: null until the table has been placed on the floor plan at least once.
  positionX: number | null;
  positionY: number | null;
  // FR-3.7a: only ever populated for a Restricted table.
  requiredGuestIds: string[];
  createdAt: string;
  updatedAt: string;
  // FR-7.7: an optimistic-concurrency counter -- send this back as expectedRevision on an edit to
  // this table so the server can detect and refuse a save based on stale data.
  revision: number;
}
