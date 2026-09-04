import { z } from "zod";

export const createTableSchema = z.object({
  label: z.string().min(1, "Table name is required").max(100),
  capacity: z.number().int().min(1).max(50),
  isRestricted: z.boolean().default(false),
  isAccessible: z.boolean().default(false),
  purpose: z.string().max(200).optional().nullable(),
});
export type CreateTableInput = z.infer<typeof createTableSchema>;

export const updateTableSchema = createTableSchema.partial();
export type UpdateTableInput = z.infer<typeof updateTableSchema>;

export interface SeatingTableDTO {
  id: string;
  weddingId: string;
  label: string;
  capacity: number;
  isRestricted: boolean;
  isAccessible: boolean;
  purpose: string | null;
  createdAt: string;
  updatedAt: string;
}
