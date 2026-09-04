import { z } from "zod";

export type PlanVersionStatusValue = "DRAFT" | "IN_REVIEW" | "APPROVED";

export const planVersionStatusSchema = z.object({
  status: z.enum(["DRAFT", "IN_REVIEW", "APPROVED"]),
});

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
}

export interface PlanVersionAssignmentDTO {
  id: string;
  guestId: string;
  guestName: string;
  tableId: string;
  tableLabel: string;
  needsReassignment: boolean;
}

export interface PlanVersionDetailDTO extends PlanVersionDTO {
  assignments: PlanVersionAssignmentDTO[];
  unassignedGuestIds: string[];
  warnings: string[];
  modifiedSinceApproval: ModifiedSinceApprovalDTO;
}

export interface GeneratePlanResponse {
  planVersion: PlanVersionDetailDTO;
  errors: string[];
}
