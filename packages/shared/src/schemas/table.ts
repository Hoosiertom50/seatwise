import { z } from "zod";

// FR-4.1: affects only the floor-plan drawing (FR-4.3), never seating logic.
export const tableShapeEnum = z.enum(["ROUND", "RECTANGULAR", "SQUARE", "OVAL", "OTHER"]);
export type TableShape = z.infer<typeof tableShapeEnum>;

export const createTableSchema = z.object({
  label: z.string().min(1, "Table name is required").max(100),
  capacity: z.number().int().min(1).max(50),
  isRestricted: z.boolean().default(false),
  isAccessible: z.boolean().default(false),
  isLocked: z.boolean().default(false),
  purpose: z.string().max(200).optional().nullable(),
  // FR-3.4: table-level override, favoring one side only regardless of the wedding's setting.
  singleSideOnly: z.boolean().default(false),
  shape: tableShapeEnum.default("ROUND"),
});
export type CreateTableInput = z.infer<typeof createTableSchema>;

export const updateTableSchema = createTableSchema.partial().extend({
  // FR-4.3: the floor plan's drag position. Nullable -- a table that's never been placed on the
  // floor plan has no position, and the UI falls back to a client-computed grid slot purely for
  // display (never persisted) until the user actually drags it. Position is display-only: it's
  // never read by generation, the engine, or any rule check.
  positionX: z.number().finite().nullable().optional(),
  positionY: z.number().finite().nullable().optional(),
});
export type UpdateTableInput = z.infer<typeof updateTableSchema>;

// FR-4.2: create a standard set of same-shape, same-capacity tables in one action (e.g. "12 round
// tables of 8"). Distinct labels are assigned automatically, continuing after any tables that
// already exist so a repeated quick-create never collides with earlier ones.
export const quickCreateTablesSchema = z.object({
  count: z.number().int().min(1).max(100),
  capacity: z.number().int().min(1).max(50),
  shape: tableShapeEnum.default("ROUND"),
  labelPrefix: z.string().min(1).max(50).default("Table"),
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
}
