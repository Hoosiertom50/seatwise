import { randomUUID } from "crypto";
import { ACCOUNT_EMAILS_PER_DAY, accountDailyEmailKey, sendEmail, type EmailResult } from "../email";
import { pool } from "../pool";
import { hitRateLimit } from "./rate-limit";
import { emailSafeWeddingName, looksLikeWebAddress } from "@seatwise/shared";

// TS-163: how many notification emails one person's actions can set off (each recipient counts).
// Generous for real planning -- approving a plan emails a handful of collaborators -- but a loop of
// comment replies, or adding a hundred guests after approval, stops emailing everyone well before
// it becomes a flood. In-app notifications are never limited.
export const NOTIFICATION_EMAILS_PER_ACTOR = [
  { limit: 60, windowSeconds: 3600 },
  { limit: 200, windowSeconds: 86_400 },
] as const;

// TS-168: the same idea for events nobody signed in caused (guests' RSVPs) -- a cap per wedding,
// so many guest links submitted in turn can't flood the planners' inboxes either.
export const NOTIFICATION_EMAILS_PER_WEDDING_WITHOUT_ACTOR = [
  { limit: 30, windowSeconds: 3600 },
  { limit: 150, windowSeconds: 86_400 },
] as const;

async function weddingMayEmailWithoutActor(weddingId: string): Promise<boolean> {
  const results = await Promise.all(
    NOTIFICATION_EMAILS_PER_WEDDING_WITHOUT_ACTOR.map(({ limit, windowSeconds }) =>
      hitRateLimit(`email:notify-wedding:${windowSeconds}:${weddingId}`, limit, windowSeconds)
    )
  );
  return results.every((r) => r.allowed);
}

// TS-168: what an email may say. A message built from names typed by people (guest names, table
// labels) only goes out if it can't read as a web address; otherwise the email just says there's
// an update, and the details stay in the app.
export function emailSafeNotificationText(message: string): string {
  return looksLikeWebAddress(message) ? "There's an update on a wedding you're part of — open Seatwise to see it." : message;
}

async function actorMayEmail(actorUserId: string): Promise<boolean> {
  const results = await Promise.all([
    ...NOTIFICATION_EMAILS_PER_ACTOR.map(({ limit, windowSeconds }) =>
      hitRateLimit(`email:notify:${windowSeconds}:${actorUserId}`, limit, windowSeconds)
    ),
    // TS-171: these count toward the account's one daily allowance for every kind of email.
    hitRateLimit(accountDailyEmailKey(actorUserId), ACCOUNT_EMAILS_PER_DAY.limit, ACCOUNT_EMAILS_PER_DAY.windowSeconds),
  ]);
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
export async function sendEmailNotification(
  toEmail: string,
  subject: string,
  body: string,
  options: { toWeddingMember?: boolean } = {}
): Promise<EmailResult> {
  return sendEmail(toEmail, subject, body, process.env, options);
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
    emailMessage,
  }: {
    /**
     * TS-163: for events nobody signed in caused (a guest's RSVP): email at most once per
     * `windowSeconds` for this `key`, so one guest link submitted over and over can't flood
     * everyone's inbox. The in-app notification is still written every time.
     */
    emailOncePer?: { key: string; windowSeconds: number };
    /** TS-168: what the email says, when it should say less than the in-app notification. */
    emailMessage?: string;
  } = {}
): Promise<void> {
  const { rows: weddingRows } = await pool.query(
    `SELECT "ownerId", name, "emailNotificationsEnabled" FROM "weddings" WHERE id = $1`,
    [weddingId]
  );
  const wedding = weddingRows[0];
  if (!wedding) return;

  const { rows: recipients } = await pool.query(
    `SELECT id, email, "emailVerifiedAt" FROM "users" WHERE id = $1
     UNION
     SELECT u.id, u.email, u."emailVerifiedAt" FROM "users" u
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
    // TS-168: only to an address its owner has confirmed (TS-164) -- otherwise anyone could sign
    // up with a stranger's address and have Seatwise email them every time a guest responded.
    if (!recipient.emailVerifiedAt) continue;
    if (mayEmail && actorUserId && !(await actorMayEmail(actorUserId))) mayEmail = false;
    if (mayEmail && !actorUserId && !(await weddingMayEmailWithoutActor(weddingId))) mayEmail = false;
    if (mayEmail) {
      const weddingName = emailSafeWeddingName(wedding.name);
      await sendEmailNotification(
        recipient.email,
        weddingName ? `Seatwise: ${weddingName}` : "Seatwise: a wedding update",
        emailSafeNotificationText(emailMessage ?? message),
        // TS-171: a confirmed member of this wedding, so not held to the per-address daily cap.
        { toWeddingMember: true }
      );
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

/**
 * TS-182: with `upTo`, only notifications created no later than it are marked -- "Mark all read"
 * sends the newest one the bell has shown, so one that arrived since isn't marked unseen. (The
 * column holds milliseconds, the same precision the bell was given.)
 */
export async function markAllNotificationsRead(userId: string, upTo?: Date): Promise<void> {
  if (upTo) {
    await pool.query(
      `UPDATE "notifications" SET "isRead" = true
        WHERE "recipientUserId" = $1 AND "isRead" = false AND "createdAt" <= $2`,
      [userId, upTo]
    );
    return;
  }
  await pool.query(
    `UPDATE "notifications" SET "isRead" = true WHERE "recipientUserId" = $1 AND "isRead" = false`,
    [userId]
  );
}
