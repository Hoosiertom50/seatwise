import { randomUUID } from "crypto";
import { pool } from "../pool";

export interface NotificationRow {
  id: string;
  weddingId: string;
  weddingName: string;
  recipientUserId: string;
  type: string;
  message: string;
  isRead: boolean;
  createdAt: Date;
}

// FR-10.2: no real email provider is wired up in this environment — this stands in for one. A
// failed "send" must never block the in-app notification or the action that triggered it, so it
// never throws; swapping in a real provider (Resend, SendGrid, SES) means replacing only this
// function's body, not any of its call sites.
async function sendEmailNotification(toEmail: string, subject: string, body: string): Promise<void> {
  try {
    console.log(`[email-stub] to=${toEmail} subject="${subject}" body="${body}"`);
  } catch {
    // best-effort — never throw
  }
}

// Every collaborator (and the wedding's owner) except whoever caused the event gets an in-app
// notification; email additionally goes out unless the wedding has opted out (FR-10.2). The
// in-app write always happens regardless of the email outcome.
export async function notifyWeddingCollaborators(
  weddingId: string,
  actorUserId: string | null,
  type:
    | "PLAN_SHARED"
    | "COMMENT_REPLY"
    | "TABLE_CHANGED"
    | "GUEST_ADDED"
    | "GUEST_REMOVED"
    | "ATTENDANCE_CHANGED"
    | "STATUS_CHANGED",
  message: string
): Promise<void> {
  const { rows: weddingRows } = await pool.query(
    `SELECT "ownerId", name, "emailNotificationsEnabled" FROM "weddings" WHERE id = $1`,
    [weddingId]
  );
  const wedding = weddingRows[0];
  if (!wedding) return;

  const { rows: recipients } = await pool.query(
    `SELECT id, email FROM "users" WHERE id = $1
     UNION
     SELECT u.id, u.email FROM "users" u
     JOIN "wedding_collaborators" wc ON wc."userId" = u.id
     WHERE wc."weddingId" = $2`,
    [wedding.ownerId, weddingId]
  );

  for (const recipient of recipients) {
    if (recipient.id === actorUserId) continue;
    await pool.query(
      `INSERT INTO "notifications" (id, "weddingId", "recipientUserId", type, message)
       VALUES ($1, $2, $3, $4::"NotificationType", $5)`,
      [randomUUID(), weddingId, recipient.id, type, message]
    );
    if (wedding.emailNotificationsEnabled) {
      await sendEmailNotification(recipient.email, `Seatwise: ${wedding.name}`, message);
    }
  }
}

export async function listNotificationsForUser(
  userId: string,
  limit = 50
): Promise<NotificationRow[]> {
  const { rows } = await pool.query(
    `SELECT n.id, n."weddingId", w.name AS "weddingName", n."recipientUserId", n.type,
            n.message, n."isRead", n."createdAt"
     FROM "notifications" n
     JOIN "weddings" w ON w.id = n."weddingId"
     WHERE n."recipientUserId" = $1
     ORDER BY n."createdAt" DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS "count" FROM "notifications" WHERE "recipientUserId" = $1 AND "isRead" = false`,
    [userId]
  );
  return rows[0].count;
}

export async function markNotificationRead(id: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE "notifications" SET "isRead" = true WHERE id = $1 AND "recipientUserId" = $2`,
    [id, userId]
  );
  return (rowCount ?? 0) > 0;
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await pool.query(
    `UPDATE "notifications" SET "isRead" = true WHERE "recipientUserId" = $1 AND "isRead" = false`,
    [userId]
  );
}
