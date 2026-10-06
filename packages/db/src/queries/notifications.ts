import { randomUUID } from "crypto";
import { ACCOUNT_EMAILS_PER_DAY, accountDailyEmailKey, emailDelivered, sendEmail, type EmailResult } from "../email";
import { pool } from "../pool";
import { hitRateLimit, undoRateLimitHit } from "./rate-limit";
import { emailSafeWeddingName, looksLikePhoneNumber, looksLikeWebAddress } from "@seatwise/shared";

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

const NEUTRAL_NOTIFICATION_TEXT = "There's an update on a wedding you're part of — open Seatwise to see it.";

// TS-168: what an email may say. A message built from names typed by people (guest names, table
// labels) only goes out if it can't read as a web address; otherwise the email just says there's
// an update, and the details stay in the app.
// TS-178: nor as a phone number, and it's always one line -- control characters and line breaks
// become spaces, so typed text can't lay itself out as a separate message inside the email.
export function emailSafeNotificationText(message: string): string {
  const oneLine = message
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return looksLikeWebAddress(oneLine) || looksLikePhoneNumber(oneLine) ? NEUTRAL_NOTIFICATION_TEXT : oneLine;
}

type Counter = { key: string; limit: number; windowSeconds: number };

/**
 * TS-178: counts one notification email against every limit it falls under. Refused once any is
 * over -- and then every count is taken back, so a full window can't quietly drain the others.
 * When allowed, `giveBack` takes all the counts back -- for an email that then didn't go out.
 */
async function reserveNotificationEmail(counters: Counter[]): Promise<{ allowed: boolean; giveBack: () => Promise<void> }> {
  const results = await Promise.all(counters.map(({ key, limit, windowSeconds }) => hitRateLimit(key, limit, windowSeconds)));
  const giveBack = async () => {
    await Promise.all(counters.map((c) => undoRateLimitHit(c.key, c.windowSeconds)));
  };
  if (results.every((r) => r.allowed)) return { allowed: true, giveBack };
  await giveBack();
  return { allowed: false, giveBack: async () => {} };
}

function notificationEmailCounters(actorUserId: string | null, weddingId: string, ownerId: string): Counter[] {
  if (actorUserId) {
    return [
      ...NOTIFICATION_EMAILS_PER_ACTOR.map(({ limit, windowSeconds }) => ({
        key: `email:notify:${windowSeconds}:${actorUserId}`,
        limit,
        windowSeconds,
      })),
      // TS-171: these count toward the account's one daily allowance for every kind of email.
      { key: accountDailyEmailKey(actorUserId), ...ACCOUNT_EMAILS_PER_DAY },
    ];
  }
  return [
    ...NOTIFICATION_EMAILS_PER_WEDDING_WITHOUT_ACTOR.map(({ limit, windowSeconds }) => ({
      key: `email:notify-wedding:${windowSeconds}:${weddingId}`,
      limit,
      windowSeconds,
    })),
    // TS-178: with nobody signed in behind it (a guest's RSVP), the email counts toward the
    // wedding owner's daily allowance instead -- otherwise many weddings, each with its own cap,
    // could send far more in a day than one account is allowed to.
    { key: accountDailyEmailKey(ownerId), ...ACCOUNT_EMAILS_PER_DAY },
  ];
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
    if (!mayEmail) continue;
    const reservation = await reserveNotificationEmail(notificationEmailCounters(actorUserId, weddingId, wedding.ownerId));
    if (!reservation.allowed) {
      mayEmail = false;
      continue;
    }
    const weddingName = emailSafeWeddingName(wedding.name);
    const result = await sendEmailNotification(
      recipient.email,
      weddingName ? `Seatwise: ${weddingName}` : "Seatwise: a wedding update",
      emailSafeNotificationText(emailMessage ?? message),
      // TS-171: a confirmed member of this wedding, so not held to the per-address daily cap.
      { toWeddingMember: true }
    );
    // TS-178: nothing went out (failed, held back by the day's limit, or no email service), so it
    // doesn't use up the sender's, the wedding's or the owner's allowance.
    if (!emailDelivered(result)) await reservation.giveBack();
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
