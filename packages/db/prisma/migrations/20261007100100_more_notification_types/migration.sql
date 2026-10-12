-- TS-213 (Tom's decisions): a new comment thread now notifies the wedding's other members, as a
-- reply does; and a hand-off tells the new owner. Each gets its own notification type.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COMMENT_ADDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'OWNERSHIP_TRANSFERRED';
