import { z } from "zod";

export const createTableSchema = z.object({
  label: z.string().min(1, "Table name is required").max(100),
  capacity: z.number().int().min(1).max(50),
  isRestricted: z.boolean().default(false),
  isAccessible: z.boolean().default(false),
  isLocked: z.boolean().default(false),
  purpose: z.string().max(200).optional().nullable(),
  // FR-3.4: table-level override, favoring one side only regardless of the wedding's setting.
  singleSideOnly: z.boolean().default(false),
});
export type CreateTableInput = z.infer<typeof createTableSchema>;

export const updateTableSchema = createTableSchema.partial();
export type UpdateTableInput = z.infer<typeof updateTableSchema>;

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
  // FR-3.7a: only ever populated for a Restricted table.
  requiredGuestIds: string[];
  createdAt: string;
  updatedAt: string;
}
