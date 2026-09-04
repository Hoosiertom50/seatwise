import { z } from "zod";

export const guestTierEnum = z.enum(["VIP", "FAMILY", "FRIEND", "PLUS_ONE", "OTHER"]);
export type GuestTier = z.infer<typeof guestTierEnum>;

export const rsvpStatusEnum = z.enum(["PENDING", "CONFIRMED", "DECLINED"]);
export type RsvpStatus = z.infer<typeof rsvpStatusEnum>;

export const createGuestSchema = z.object({
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  partyName: z.string().max(200).optional().nullable(),
  headcount: z.number().int().min(1).max(20).default(1),
  tier: guestTierEnum.default("OTHER"),
  rsvpStatus: rsvpStatusEnum.default("PENDING"),
  requiresAccessibleTable: z.boolean().default(false),
  isLocked: z.boolean().default(false),
  notes: z.string().max(2000).optional().nullable(),
});
export type CreateGuestInput = z.infer<typeof createGuestSchema>;

export const updateGuestSchema = createGuestSchema.partial();
export type UpdateGuestInput = z.infer<typeof updateGuestSchema>;

export interface GuestDTO {
  id: string;
  weddingId: string;
  firstName: string;
  lastName: string;
  partyName: string | null;
  headcount: number;
  tier: GuestTier;
  rsvpStatus: RsvpStatus;
  requiresAccessibleTable: boolean;
  isLocked: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
