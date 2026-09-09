-- TS-13 (Collaboration & Notifications, FR-10.1/10.2/10.3): a real collaborator/permissions
-- model (View/Comment/Edit, on top of the wedding's owner), comments attached to a guest or
-- table (surviving that target's later change or removal), and in-app notifications with a
-- per-wedding email opt-out.

ALTER TABLE "weddings" ADD COLUMN "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TYPE "CollaboratorPermission" AS ENUM ('VIEW', 'COMMENT', 'EDIT');

CREATE TABLE "wedding_collaborators" (
    "id" TEXT NOT NULL,
    "weddingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permissionLevel" "CollaboratorPermission" NOT NULL DEFAULT 'VIEW',
    "invitedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wedding_collaborators_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wedding_collaborators_weddingId_userId_key" ON "wedding_collaborators"("weddingId", "userId");
CREATE INDEX "wedding_collaborators_userId_idx" ON "wedding_collaborators"("userId");

ALTER TABLE "wedding_collaborators" ADD CONSTRAINT "wedding_collaborators_weddingId_fkey"
    FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wedding_collaborators" ADD CONSTRAINT "wedding_collaborators_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "CommentTargetType" AS ENUM ('GUEST', 'TABLE');

CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "weddingId" TEXT NOT NULL,
    "targetType" "CommentTargetType" NOT NULL,
    "guestId" TEXT,
    "tableId" TEXT,
    "targetLabel" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "parentCommentId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "comments_weddingId_idx" ON "comments"("weddingId");
CREATE INDEX "comments_guestId_idx" ON "comments"("guestId");
CREATE INDEX "comments_tableId_idx" ON "comments"("tableId");

ALTER TABLE "comments" ADD CONSTRAINT "comments_weddingId_fkey"
    FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_guestId_fkey"
    FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "seating_tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorUserId_fkey"
    FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentCommentId_fkey"
    FOREIGN KEY ("parentCommentId") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "NotificationType" AS ENUM (
    'PLAN_SHARED', 'COMMENT_REPLY', 'TABLE_CHANGED', 'GUEST_ADDED', 'GUEST_REMOVED',
    'ATTENDANCE_CHANGED', 'STATUS_CHANGED'
);

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "weddingId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_recipientUserId_idx" ON "notifications"("recipientUserId");
CREATE INDEX "notifications_weddingId_idx" ON "notifications"("weddingId");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_weddingId_fkey"
    FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientUserId_fkey"
    FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
