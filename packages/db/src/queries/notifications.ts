import { randomUUID } from "crypto";
import { sendEmail, type EmailResult } from "../email";
import { pool } from "../pool";
import { hitRateLimit } from "./rate-limit";

// TS-163: how many notification emails one person's actions can set off (each recipient counts).
// Generous for real planning -- approving a plan emails a handful of collaborators -- but a loop of
// comment replies, or adding a hundred guests after approval, stops emailing everyone well before
// it becomes a flood. In-app notifications are never limited.
export const NOTIFICATION_EMAILS_PER_ACTOR = [
  { limit: 60, windowSeconds: 3600 },
  { limit: 200, windowSeconds: 86_400 },
] as const;

async function actorMayEmail(actorUserId: string): Promise<boolean> {
  const results = await Promise.all(
    NOTIFICATION_EMAILS_PER_ACTOR.map(({ limit, windowSeconds }) =>
      hitRateLimit(`email:notify:${windowSeconds}:${actorUserId}`, limit, windowSeconds)
    )
  );
  return results.every((r) => r.allowed);
}

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

// FR-10.2 / TS-132: email goes through ../email.ts, which picks Gmail SMTP, Resend, a log line
// (local dev and CI) or nothing (production with no email service set up) -- and never throws.
// Returns what happened, so a caller can tell the planner when an email didn't go out.
export async function sendEmailNotification(toEmail: string, subject: string, body: string): Promise<EmailResult> {
  return sendEmail(toEmail, subject, body);
}

// Every collaborator (and the wedding's owner) except whoever caused the event gets an in-app
// notification; email additionally goes out unless the wedding has opted out (FR-10.2). The
// in-app write always happens regardless of the email outcome.
export async function notifyWeddingCollaborators(
  weddingId: string,
  actorUserId: string | null,
  type:
    | "RSVP_RECEIVED"
    | "PLAN_SHARED"
    | "COMMENT_REPLY"
    | "TABLE_CHANGED"
    | "GUEST_ADDED"
    | "GUEST_REMOVED"
    | "ATTENDANCE_CHANGED"
    | "STATUS_CHANGED",
  message: string,
  {
    emailOncePer,
  }: {
    /**
     * TS-163: for events nobody signed in caused (a guest's RSVP): email at most once per
     * `windowSeconds` for this `key`, so one guest link submitted over and over can't flood
     * everyone's inbox. The in-app notification is still written every time.
     */
    emailOncePer?: { key: string; windowSeconds: number };
  } = {}
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

  let mayEmail: boolean = wedding.emailNotificationsEnabled;
  if (mayEmail && emailOncePer) {
    mayEmail = (await hitRateLimit(emailOncePer.key, 1, emailOncePer.windowSeconds)).allowed;
  }

  for (const recipient of recipients) {
    if (recipient.id === actorUserId) continue;
    await pool.query(
      `INSERT INTO "notifications" (id, "weddingId", "recipientUserId", type, message)
       VALUES ($1, $2, $3, $4::"NotificationType", $5)`,
      [randomUUID(), weddingId, recipient.id, type, message]
    );
    if (mayEmail && actorUserId && !(await actorMayEmail(actorUserId))) mayEmail = false;
    if (mayEmail) {
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
