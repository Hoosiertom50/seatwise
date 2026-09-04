import { randomUUID } from "crypto";
import { Resend } from "resend";
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

// FR-10.2: real email delivery via Resend. This sandbox has no real Resend account, so
// RESEND_API_KEY is an env-var placeholder — see .env.example. With no key configured, this falls
// back to the same console-log stand-in the app always used, so local/dev/sandbox behavior (and
// every existing test) is unaffected; set RESEND_API_KEY (and optionally RESEND_FROM_EMAIL, which
// must be a verified sending address/domain in the Resend account) to send real email instead. A
// failed "send" — no key, a rejected request, a network error — must never block the in-app
// notification or the action that triggered it, so this never throws.
const resendFromAddress = process.env.RESEND_FROM_EMAIL || "Seatwise <notifications@seatwise.app>";
let resendClient: Resend | null | undefined;

function getResendClient(): Resend | null {
  if (resendClient === undefined) {
    const apiKey = process.env.RESEND_API_KEY;
    resendClient = apiKey ? new Resend(apiKey) : null;
  }
  return resendClient;
}

async function sendEmailNotification(toEmail: string, subject: string, body: string): Promise<void> {
  try {
    const client = getResendClient();
    if (!client) {
      console.log(`[email-stub] to=${toEmail} subject="${subject}" body="${body}"`);
      return;
    }
    const { error } = await client.emails.send({
      from: resendFromAddress,
      to: toEmail,
      subject,
      text: body,
    });
    if (error) {
      console.error(`[email] Resend rejected a notification to ${toEmail}: ${error.message}`);
    }
  } catch (err) {
    console.error(`[email] failed to send notification to ${toEmail}:`, err);
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
