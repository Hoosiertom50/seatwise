import { z } from "zod";

export const createWeddingSchema = z.object({
  name: z.string().min(1, "Wedding name is required").max(200),
  eventDate: z.string().date().optional().nullable(),
  venueName: z.string().max(200).optional().nullable(),
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
  createdAt: string;
  updatedAt: string;
}
