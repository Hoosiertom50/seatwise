import { randomUUID } from "crypto";
import { accountDailyEmailKey, accountDailyEmailLimit, emailDelivered, sendEmail, type EmailResult } from "../email";
import { pool } from "../pool";
import { claimCooldown, hitRateLimit, releaseCooldown, undoRateLimitHit } from "./rate-limit";
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
// TS-186 (Tom's decision): these emails no longer count against the wedding owner's own daily
// allowance -- guests' answers could use it up and stop the owner sending invites and RSVP links.
// Each wedding has its own daily pool for them instead (50), on top of the hourly cap.
export const NOTIFICATION_EMAILS_PER_WEDDING_WITHOUT_ACTOR = [
  { limit: 30, windowSeconds: 3600 },
  { limit: 50, windowSeconds: 86_400 },
] as const;

// TS-194 (Tom's decision): and a daily pool per wedding OWNER, across all their weddings -- so
// creating more weddings doesn't multiply what guests' answers can send to one owner's planners.
export const NOTIFICATION_EMAILS_PER_OWNER_WITHOUT_ACTOR = { limit: 60, windowSeconds: 86_400 } as const;
export const ownerNotificationEmailKey = (ownerId: string) => `email:notify-owner:86400:${ownerId}`;

// TS-186 (Tom's decision): a guest's changed RSVP answer is emailed to the planners at most this
// many times per guest per day; after that it only shows in the app.
export const CHANGED_RSVP_EMAILS_PER_GUEST_PER_DAY = { limit: 3, windowSeconds: 86_400 } as const;

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
 * TS-186: each count is taken back from the window it was made in.
 */
async function reserveNotificationEmail(counters: Counter[]): Promise<{ allowed: boolean; giveBack: () => Promise<void> }> {
  const results = await Promise.all(counters.map(({ key, limit, windowSeconds }) => hitRateLimit(key, limit, windowSeconds)));
  const giveBack = async () => {
    await Promise.all(counters.map((c, i) => undoRateLimitHit(c.key, c.windowSeconds, results[i].windowStart)));
  };
  if (results.every((r) => r.allowed)) return { allowed: true, giveBack };
  await giveBack();
  return { allowed: false, giveBack: async () => {} };
}

async function notificationEmailCounters(actorUserId: string | null, weddingId: string, ownerId: string): Promise<Counter[]> {
  if (actorUserId) {
    // TS-194: a new account's allowance is smaller (see accountDailyEmailLimit).
    const { limit, windowSeconds } = await accountDailyEmailLimit(actorUserId);
    return [
      ...NOTIFICATION_EMAILS_PER_ACTOR.map(({ limit, windowSeconds }) => ({
        key: `email:notify:${windowSeconds}:${actorUserId}`,
        limit,
        windowSeconds,
      })),
      // TS-171: these count toward the account's one daily allowance for every kind of email.
      { key: accountDailyEmailKey(actorUserId), limit, windowSeconds },
    ];
  }
  // TS-186 (Tom's decision): with nobody signed in behind it (a guest's RSVP), only the wedding's
  // own pool counts -- not the owner's daily allowance (see NOTIFICATION_EMAILS_PER_WEDDING_WITHOUT_ACTOR).
  // The number of weddings one account can create in a day is capped (TS-178), and every email
  // still counts against the site's daily ceiling.
  return [
    ...NOTIFICATION_EMAILS_PER_WEDDING_WITHOUT_ACTOR.map(({ limit, windowSeconds }) => ({
      key: `email:notify-wedding:${windowSeconds}:${weddingId}`,
      limit,
      windowSeconds,
    })),
    // TS-194: and the owner's pool across all their weddings.
    { key: ownerNotificationEmailKey(ownerId), ...NOTIFICATION_EMAILS_PER_OWNER_WITHOUT_ACTOR },
  ];
}

/**
 * TS-186: the rule a caller gave for whether this event may be emailed at all (once an hour, or a
 * few times a day). Taken back with `release` if no email went out after all.
 */
async function claimEmailGate(
  oncePer: { key: string; windowSeconds: number } | undefined,
  atMost: { key: string; limit: number; windowSeconds: number } | undefined
): Promise<{ allowed: boolean; release: () => Promise<void> }> {
  const releases: (() => Promise<void>)[] = [];
  const release = async () => {
    for (const undo of releases.splice(0).reverse()) await undo();
  };
  if (oncePer) {
    const claim = await claimCooldown(oncePer.key, oncePer.windowSeconds);
    if (!claim.allowed || !claim.claimedAt) return { allowed: false, release: async () => {} };
    const claimedAt = claim.claimedAt;
    releases.push(() => releaseCooldown(oncePer.key, claimedAt));
  }
  if (atMost) {
    const hit = await hitRateLimit(atMost.key, atMost.limit, atMost.windowSeconds);
    releases.push(() => undoRateLimitHit(atMost.key, atMost.windowSeconds, hit.windowStart));
    if (!hit.allowed) {
      // Refused: nothing counted stays counted.
      await release();
      return { allowed: false, release: async () => {} };
    }
  }
  return { allowed: true, release };
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
    emailAtMost,
    emailMessage,
  }: {
    /**
     * TS-163: for events nobody signed in caused (a guest's RSVP): email at most once per
     * `windowSeconds` for this `key`, so one guest link submitted over and over can't flood
     * everyone's inbox. The in-app notification is still written every time.
     * TS-186: a real `windowSeconds` since the last email -- refused tries don't push it back.
     */
    emailOncePer?: { key: string; windowSeconds: number };
    /** TS-186: email at most `limit` times per `windowSeconds` for this `key` (in-app every time). */
    emailAtMost?: { key: string; limit: number; windowSeconds: number };
    /** TS-168: what the email says, when it should say less than the in-app notification. */
    emailMessage?: string;
  } = {}
): Promise<void> {
  // TS-194: best effort, always. This runs after the change it's about has been saved, so a failure
  // here (a recipient's account deleted a moment ago, the database busy) must never reach the
  // caller and turn a saved change into an error. Each recipient is tried on their own, too, so one
  // failure doesn't stop the others hearing about it.
  try {
    await notifyEveryone(weddingId, actorUserId, type, message, { emailOncePer, emailAtMost, emailMessage });
  } catch (err) {
    console.error(`[notify] ${type} for wedding ${weddingId} wasn't fully sent: ${errorCode(err)}`);
  }
}

const errorCode = (err: unknown) => {
  const code = (err as { code?: string } | null)?.code;
  return code ? `database error ${code}` : err instanceof Error ? err.message : String(err);
};

async function notifyEveryone(
  weddingId: string,
  actorUserId: string | null,
  type: string,
  message: string,
  {
    emailOncePer,
    emailAtMost,
    emailMessage,
  }: {
    emailOncePer?: { key: string; windowSeconds: number };
    emailAtMost?: { key: string; limit: number; windowSeconds: number };
    emailMessage?: string;
  }
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

  const notified: typeof recipients = [];
  for (const recipient of recipients) {
    if (recipient.id === actorUserId) continue;
    // TS-186: written only if they're still the owner or a collaborator at this moment -- someone
    // removed while this was running (between the list above and here) gets neither the
    // notification nor the email.
    try {
      const { rowCount } = await pool.query(
        `INSERT INTO "notifications" (id, "weddingId", "recipientUserId", type, message)
         SELECT $1, $2, $3, $4::"NotificationType", $5
         WHERE EXISTS (SELECT 1 FROM "weddings" WHERE id = $2 AND "ownerId" = $3)
            OR EXISTS (SELECT 1 FROM "wedding_collaborators" WHERE "weddingId" = $2 AND "userId" = $3)`,
        [randomUUID(), weddingId, recipient.id, type, message]
      );
      if (rowCount) notified.push(recipient);
    } catch (err) {
      // TS-194: 23503 -- their account (or the wedding) was deleted a moment ago; nothing to tell
      // them. Anything else is logged. Either way the rest still hear about it.
      if ((err as { code?: string } | null)?.code !== "23503") {
        console.error(`[notify] couldn't write a ${type} notification: ${errorCode(err)}`);
      }
    }
  }

  if (!wedding.emailNotificationsEnabled) return;
  // TS-168: only to an address its owner has confirmed (TS-164) -- otherwise anyone could sign
  // up with a stranger's address and have Seatwise email them every time a guest responded.
  const toEmail = notified.filter((recipient) => recipient.emailVerifiedAt);
  if (toEmail.length === 0) return;

  // TS-186: checked only once there's someone to email, and given back if nobody was emailed --
  // so an event that emailed no one doesn't hold back the next one.
  const gate = await claimEmailGate(emailOncePer, emailAtMost);
  if (!gate.allowed) return;
  let anyEmailed = false;
  try {
    const counters = await notificationEmailCounters(actorUserId, weddingId, wedding.ownerId);
    const weddingName = emailSafeWeddingName(wedding.name);
    for (const recipient of toEmail) {
      try {
        // TS-194: checked again right before each email -- someone removed from the wedding, or
        // whose account was deleted or changed address, since the list above isn't emailed.
        const { rows: still } = await pool.query<{ email: string }>(
          `SELECT u.email FROM "users" u
            WHERE u.id = $1 AND u."emailVerifiedAt" IS NOT NULL
              AND (EXISTS (SELECT 1 FROM "weddings" WHERE id = $2 AND "ownerId" = u.id)
                OR EXISTS (SELECT 1 FROM "wedding_collaborators" WHERE "weddingId" = $2 AND "userId" = u.id))`,
          [recipient.id, weddingId]
        );
        if (!still[0]) continue;
        const reservation = await reserveNotificationEmail(counters);
        if (!reservation.allowed) break;
        const result = await sendEmailNotification(
          still[0].email,
          weddingName ? `Seatwise: ${weddingName}` : "Seatwise: a wedding update",
          emailSafeNotificationText(emailMessage ?? message),
          // TS-171: a confirmed member of this wedding, so not held to the per-address daily cap.
          { toWeddingMember: true }
        );
        // TS-178: nothing went out (failed, held back by the day's limit, or no email service), so it
        // doesn't use up the sender's or the wedding's allowance.
        if (emailDelivered(result)) anyEmailed = true;
        else await reservation.giveBack();
      } catch (err) {
        // TS-194: one recipient's failure is logged; the others are still emailed.
        console.error(`[notify] couldn't email a ${type} notification: ${errorCode(err)}`);
      }
    }
  } finally {
    if (!anyEmailed) await gate.release();
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
