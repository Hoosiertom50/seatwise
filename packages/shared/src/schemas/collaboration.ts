import { z } from "zod";

// TS-13 (Collaboration & Notifications, FR-10.x): View/Comment/Edit collaborator access, plus
// comments attached to a guest or table and in-app notifications.

export const collaboratorPermissionEnum = z.enum(["VIEW", "COMMENT", "EDIT"]);
export type CollaboratorPermission = z.infer<typeof collaboratorPermissionEnum>;

export const addCollaboratorSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  permissionLevel: collaboratorPermissionEnum.default("VIEW"),
});
export type AddCollaboratorInput = z.infer<typeof addCollaboratorSchema>;

export const updateCollaboratorSchema = z.object({
  permissionLevel: collaboratorPermissionEnum,
});
export type UpdateCollaboratorInput = z.infer<typeof updateCollaboratorSchema>;

export interface CollaboratorDTO {
  id: string;
  weddingId: string;
  userId: string;
  userName: string;
  userEmail: string;
  permissionLevel: CollaboratorPermission;
  invitedByUserId: string | null;
  createdAt: string;
}

export const commentTargetTypeEnum = z.enum(["GUEST", "TABLE"]);
export type CommentTargetType = z.infer<typeof commentTargetTypeEnum>;

export const createCommentSchema = z
  .object({
    targetType: commentTargetTypeEnum,
    guestId: z.string().optional().nullable(),
    tableId: z.string().optional().nullable(),
    body: z.string().min(1, "Comment can't be empty").max(4000),
    parentCommentId: z.string().optional().nullable(),
  })
  .refine((v) => (v.targetType === "GUEST" ? !!v.guestId : !!v.tableId), {
    message: "guestId or tableId must match targetType",
    path: ["targetType"],
  });
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export interface CommentDTO {
  id: string;
  weddingId: string;
  targetType: CommentTargetType;
  guestId: string | null;
  tableId: string | null;
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
