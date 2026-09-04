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

export const moveGuestAssignmentSchema = z.object({
  guestId: z.string().min(1),
  tableId: z.string().min(1),
});
export type MoveGuestAssignmentInput = z.infer<typeof moveGuestAssignmentSchema>;

// FR-8.1 (Day-Of Mode): swap two guests' (or their forced-together units') tables in one move.
export const swapGuestAssignmentsSchema = z.object({
  guestAId: z.string().min(1),
  guestBId: z.string().min(1),
});
export type SwapGuestAssignmentsInput = z.infer<typeof swapGuestAssignmentsSchema>;

// FR-8.1: flip a guest's same-day attendance signal (independent of rsvpStatus).
export const setAttendanceSchema = z.object({
  attendance: z.enum(["ATTENDING", "NOT_ATTENDING"]),
});
export type SetAttendanceInput = z.infer<typeof setAttendanceSchema>;
