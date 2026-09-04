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
  name: string;
  eventDate: string | null;
  venueName: string | null;
  guestCount: number;
  createdAt: string;
  updatedAt: string;
}
