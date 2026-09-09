import { z } from "zod";

// TS-13 (Collaboration & Notifications, FR-10.x): View/Comment/Edit collaborator access, plus
// comments attached to a guest or table and in-app notifications.

export const collaboratorPermissionEnum = z.enum(["VIEW", "COMMENT", "EDIT"]);
export type CollaboratorPermission = z.infer<typeof collaboratorPermissionEnum>;

// FR-1.4: a role assigned at invite time, separate from permission level. A Couple member's
// approval authority (FR-6.4) is the only place this is currently read.
export const collaboratorRoleEnum = z.enum(["COUPLE", "COLLABORATOR"]);
export type CollaboratorRole = z.infer<typeof collaboratorRoleEnum>;

export const addCollaboratorSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  permissionLevel: collaboratorPermissionEnum.default("VIEW"),
  role: collaboratorRoleEnum.default("COLLABORATOR"),
});
export type AddCollaboratorInput = z.infer<typeof addCollaboratorSchema>;

export const updateCollaboratorSchema = z.object({
  permissionLevel: collaboratorPermissionEnum.optional(),
  role: collaboratorRoleEnum.optional(),
}).refine((v) => v.permissionLevel !== undefined || v.role !== undefined, {
  message: "Provide a permissionLevel or a role to update",
});
export type UpdateCollaboratorInput = z.infer<typeof updateCollaboratorSchema>;

export interface CollaboratorDTO {
  id: string;
  weddingId: string;
  userId: string;
  userName: string;
  userEmail: string;
  role: CollaboratorRole;
  permissionLevel: CollaboratorPermission;
  invitedByUserId: string | null;
  createdAt: string;
}

// FR-1.4a: a real invite lifecycle -- carries no guest data, looked up only by its opaque token,
// and must be accepted by someone signed in with the exact invited address.
export const createInviteSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  permissionLevel: collaboratorPermissionEnum.default("VIEW"),
  role: collaboratorRoleEnum.default("COLLABORATOR"),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const inviteStatusEnum = z.enum([
  "PENDING",
  "ACCEPTED",
  "REVOKED",
  "EXPIRED",
  // Only ever returned from the token-lookup endpoint, never stored: the invite is otherwise
  // valid, but the person looking it up is signed in with a different account than was invited.
  "MISMATCHED_ACCOUNT",
  "NOT_FOUND",
]);
export type InviteStatus = z.infer<typeof inviteStatusEnum>;

// The management view (owner, listing invites on the Collaborators tab) -- includes the invited
// email, since the owner is the one who sent it.
export interface WeddingInviteDTO {
  id: string;
  weddingId: string;
  email: string;
  role: CollaboratorRole;
  permissionLevel: CollaboratorPermission;
  status: InviteStatus;
  invitedByUserId: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

// The public, token-lookup view (the invitee's accept page) -- deliberately excludes any wedding
// data at all unless the invite is genuinely PENDING and the address matches, so an expired,
// revoked, already-accepted, or mismatched-account invite reveals nothing.
export interface InvitePreviewDTO {
  status: InviteStatus;
  weddingName?: string;
  role?: CollaboratorRole;
  permissionLevel?: CollaboratorPermission;
  invitedEmail?: string;
}

// TS-18 (FR-13.3): a third target alongside GUEST/TABLE -- a comment on a single timeline entry.
export const commentTargetTypeEnum = z.enum(["GUEST", "TABLE", "TIMELINE_ENTRY"]);
export type CommentTargetType = z.infer<typeof commentTargetTypeEnum>;

export const createCommentSchema = z
  .object({
    targetType: commentTargetTypeEnum,
    guestId: z.string().optional().nullable(),
    tableId: z.string().optional().nullable(),
    timelineEntryId: z.string().optional().nullable(),
    body: z.string().min(1, "Comment can't be empty").max(4000),
    parentCommentId: z.string().optional().nullable(),
  })
  .refine(
    (v) =>
      v.targetType === "GUEST"
        ? !!v.guestId
        : v.targetType === "TABLE"
          ? !!v.tableId
          : !!v.timelineEntryId,
    {
      message: "guestId, tableId, or timelineEntryId must match targetType",
      path: ["targetType"],
    }
  );
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export interface CommentDTO {
  id: string;
  weddingId: string;
  targetType: CommentTargetType;
  guestId: string | null;
  tableId: string | null;
  timelineEntryId: string | null;
  targetLabel: string;
  targetRemoved: boolean;
  body: string;
  authorUserId: string;
  authorName: string;
  parentCommentId: string | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  resolvedByName: string | null;
  createdAt: string;
}

export interface ActivityEntryDTO {
  id: string;
  planVersionId: string;
  versionNumber: number;
  action: string;
  description: string;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: string;
}

export const notificationTypeEnum = z.enum([
  "PLAN_SHARED",
  "COMMENT_REPLY",
  "TABLE_CHANGED",
  "GUEST_ADDED",
  "GUEST_REMOVED",
  "ATTENDANCE_CHANGED",
  "STATUS_CHANGED",
]);
export type NotificationType = z.infer<typeof notificationTypeEnum>;

export interface NotificationDTO {
  id: string;
  weddingId: string;
  weddingName: string;
  recipientUserId: string;
  type: NotificationType;
  message: string;
  isRead: boolean;
  createdAt: string;
}

export const setEmailNotificationsSchema = z.object({
  emailNotificationsEnabled: z.boolean(),
});
export type SetEmailNotificationsInput = z.infer<typeof setEmailNotificationsSchema>;
