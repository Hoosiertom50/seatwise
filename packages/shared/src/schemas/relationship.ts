import { z } from "zod";

export const relationshipTypeEnum = z.enum([
  "MUST_SIT_TOGETHER",
  "MUST_NOT_SIT_TOGETHER",
  "PREFER_NEAR",
  "AVOID",
]);
export type RelationshipTypeValue = z.infer<typeof relationshipTypeEnum>;

export const createRelationshipSchema = z.object({
  guestAId: z.string().min(1),
  guestBId: z.string().min(1),
  type: relationshipTypeEnum,
});
export type CreateRelationshipInput = z.infer<typeof createRelationshipSchema>;

export interface RelationshipDTO {
  id: string;
  weddingId: string;
  guestAId: string;
  guestBId: string;
  guestAName: string;
  guestBName: string;
  type: RelationshipTypeValue;
  createdAt: string;
}
