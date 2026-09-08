import { z } from "zod";

// FR-3.4: how much generation weights table composition toward mixing the two sides. Always a
// soft preference — see packages/shared/src/seating-engine.ts.
export const sideMixingEnum = z.enum(["KEEP_SEPARATE", "BALANCED_MIX", "FULLY_MIXED"]);
export type SideMixing = z.infer<typeof sideMixingEnum>;

export const createWeddingSchema = z.object({
  name: z.string().min(1, "Wedding name is required").max(200),
  eventDate: z.string().date().optional().nullable(),
  venueName: z.string().max(200).optional().nullable(),
  sideMixing: sideMixingEnum.default("BALANCED_MIX"),
  // FR-1.3a: this wedding's own name for each side (e.g. "Bride"/"Groom") -- a display label
  // only. Renaming never touches the underlying GuestSide value (BRIDE/GROOM/BOTH) stored on any
  // guest, so no guest, rule, or assignment is recreated or lost when these change.
  sideLabel1: z.string().min(1, "Side label is required").max(40).default("Bride"),
  sideLabel2: z.string().min(1, "Side label is required").max(40).default("Groom"),
});
export type CreateWeddingInput = z.infer<typeof createWeddingSchema>;

export const updateWeddingSchema = createWeddingSchema.partial();
export type UpdateWeddingInput = z.infer<typeof updateWeddingSchema>;

export interface WeddingDTO {
  id: string;
  ownerId: string;
  name: string;
  eventDate: string | null;
  venueName: string | null;
  guestCount: number;
  // FR-10.2: per-wedding opt-out for the email side of notifications (the in-app notification
  // itself always fires regardless).
  emailNotificationsEnabled: boolean;
  // FR-3.4
  sideMixing: SideMixing;
  // FR-1.3a
  sideLabel1: string;
  sideLabel2: string;
  createdAt: string;
  updatedAt: string;
}
