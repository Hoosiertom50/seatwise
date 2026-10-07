import { randomUUID } from "crypto";
import { accountDailyEmailLimit, emailMayHaveGone, sendEmail, type EmailResult } from "../email";
import { pool } from "../pool";
import { claimCooldown, hitRateLimit, releaseCooldown, undoRateLimitHit } from "./rate-limit";
import { appBaseUrl, emailSafeWeddingName, looksLikePhoneNumber, looksLikeWebAddress } from "@seatwise/shared";

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
// TS-203: rolling over the last 24 hours (it used to start again at midnight UTC, so twice the pool
// fitted in a couple of hours) -- and only 20 while the owner's account is in its first week, so a
// few fresh accounts can't use guests' answers (their own guests' links, submitted in turn) to
// spend Seatwise's email allowance. TS-219: these no longer count toward the owner's share of the
// everyday allowance (ACCOUNT_SHARE_OF_EVERYDAY in ../email.ts) -- see notificationEmailCharge.
export const NOTIFICATION_EMAILS_PER_OWNER_WITHOUT_ACTOR = { limit: 60, windowSeconds: 86_400 } as const;
export const NEW_OWNER_NOTIFICATION_EMAILS_WITHOUT_ACTOR = { limit: 20, windowSeconds: 86_400 } as const;
export const ownerNotificationEmailKey = (ownerId: string) => `email:notify-owner:86400:${ownerId}`;

// TS-232: the notification emails one person's own actions set off have a daily allowance of their
// own, the same size as the account's allowance for invites and RSVP links (20 in its first week,
// 100 after -- see accountDailyEmailLimit). They used to come out of that same allowance, so a
// first-week planner with two collaborators used 3 of their 20 on every guest they added (the RSVP
// link plus a "guest added" email to each collaborator) and could only email about 6 guests their
// link. Real sends are still held to the account's share of Seatwise's email (see sendEmail).
export const actorNotificationEmailKey = (userId: string) => `email:notify-account:day:${userId}`;

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
export async function reserveNotificationEmail(counters: Counter[]): Promise<{ allowed: boolean; giveBack: () => Promise<void> }> {
  // TS-232: every count settles before anything is decided; if one of them failed (the database
  // busy), the ones that landed are given back before the error goes on -- they used to stay
  // counted with no email sent.
  const settled = await Promise.allSettled(counters.map(({ key, limit, windowSeconds }) => hitRateLimit(key, limit, windowSeconds)));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    await Promise.all(
      settled.map((r, i) =>
        r.status === "fulfilled" ? undoRateLimitHit(counters[i].key, counters[i].windowSeconds, r.value.windowStart).catch(() => {}) : null
      )
    );
    throw failed.reason;
  }
  const results = settled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof hitRateLimit>>>).value);
  const giveBack = async () => {
    await Promise.all(counters.map((c, i) => undoRateLimitHit(c.key, c.windowSeconds, results[i].windowStart)));
  };
  if (results.every((r) => r.allowed)) return { allowed: true, giveBack };
  await giveBack();
  return { allowed: false, giveBack: async () => {} };
}

export async function notificationEmailCounters(actorUserId: string | null, weddingId: string, ownerId: string): Promise<Counter[]> {
  if (actorUserId) {
    // TS-194: a new account's allowance is smaller (see accountDailyEmailLimit).
    const { limit, windowSeconds } = await accountDailyEmailLimit(actorUserId);
    return [
      ...NOTIFICATION_EMAILS_PER_ACTOR.map(({ limit, windowSeconds }) => ({
        key: `email:notify:${windowSeconds}:${actorUserId}`,
        limit,
        windowSeconds,
      })),
      // TS-171: these counted toward the account's one daily allowance for every kind of email.
      // TS-232: they now have one of their own, the same size (see actorNotificationEmailKey).
      { key: actorNotificationEmailKey(actorUserId), limit, windowSeconds },
    ];
  }
  // TS-186 (Tom's decision): with nobody signed in behind it (a guest's RSVP), only the wedding's
  // own pool counts -- not the owner's daily allowance (see NOTIFICATION_EMAILS_PER_WEDDING_WITHOUT_ACTOR).
  // The number of weddings one account can create in a day is capped (TS-178), and every email
  // still counts against the site's daily ceiling.
  // TS-203: a new owner account's pool is smaller.
  const { newAccount } = await accountDailyEmailLimit(ownerId);
  return [
    ...NOTIFICATION_EMAILS_PER_WEDDING_WITHOUT_ACTOR.map(({ limit, windowSeconds }) => ({
      key: `email:notify-wedding:${windowSeconds}:${weddingId}`,
      limit,
      windowSeconds,
    })),
    // TS-194: and the owner's pool across all their weddings.
    {
      key: ownerNotificationEmailKey(ownerId),
      ...(newAccount ? NEW_OWNER_NOTIFICATION_EMAILS_WITHOUT_ACTOR : NOTIFICATION_EMAILS_PER_OWNER_WITHOUT_ACTOR),
    },
  ];
}

/**
 * TS-213: who of the people just notified in the app also gets the email -- someone who has
 * confirmed their address (TS-168) and hasn't turned emails off for this wedding ("Email me about
 * this wedding"). Pure, so it can be unit-tested.
 */
export function notificationEmailRecipients<T extends { emailVerifiedAt: Date | null; wantsEmail: boolean }>(notified: T[]): T[] {
  return notified.filter((recipient) => recipient.emailVerifiedAt && recipient.wantsEmail);
}

/**
 * TS-213: a notification email's text -- the update itself, then why it came and how to stop it.
 * Before, it was the one line alone: no way into the app, no reason, no way to stop it, so the only
 * way out was to mark it as spam -- and enough of that gets Seatwise's Gmail account suspended.
 */
export function notificationEmailBody({
  text,
  weddingName,
  weddingUrl,
}: {
  text: string;
  weddingName: string | null;
  weddingUrl: string | null;
}): string {
  const wedding = weddingName ? `"${weddingName}"` : "a wedding";
  return [
    text,
    "",
    "—",
    ...(weddingUrl ? [`Open the wedding in Seatwise: ${weddingUrl}`] : []),
    `You're getting this because you're a member of ${wedding} on Seatwise.`,
    // TS-223: worded to fit owners too -- their switch is in the wedding's settings on that tab, not on a row.
    `To stop these emails: open the wedding → Collaborators, and turn off "Email me about this wedding". You'll still see updates in the app.`,
  ].join("\n");
}

/**
 * TS-219: who a notification email is charged to. Someone's own action: their account (its share
 * of Seatwise's email). A guest's answer (no one signed in): nobody's share -- TS-186 (Tom's
 * decision) says guests' answers must never use up the owner's own email, but each one was still
 * charged to the owner's share, so an RSVP rush could stop the owner sending invites and RSVP
 * links. Those are bounded by the wedding's and the owner's pools for guests' answers (see
 * notificationEmailCounters) and the site's limits instead; `forGuestsOf` only lets a first-week
 * owner's count toward the first-week accounts' combined share. Pure, so it can be unit-tested.
 */
export function notificationEmailCharge(actorUserId: string | null, ownerId: string): { account?: string; forGuestsOf?: string } {
  return actorUserId ? { account: actorUserId } : { forGuestsOf: ownerId };
}

/** TS-213: the wedding's page, for the email's link -- left out when the site's own address isn't set up. */
function weddingPageUrl(weddingId: string): string | null {
  try {
    return `${appBaseUrl()}/weddings/${weddingId}`;
  } catch {
    return null;
  }
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
  // TS-203: `account` -- who the email is charged to (see sendEmail). TS-219: `forGuestsOf` -- for
  // an email a guest set off, the wedding's owner (not charged to them; see sendEmail).
  options: { toWeddingMember?: boolean; account?: string; forGuestsOf?: string } = {}
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
    | "STATUS_CHANGED"
    // TS-213
    | "COMMENT_ADDED"
    | "OWNERSHIP_TRANSFERRED",
  message: string,
  {
    emailOncePer,
    emailAtMost,
    emailMessage,
    onlyUserIds,
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
    /** TS-213: only these members (still the owner or a collaborator) -- e.g. the new owner after a hand-off. */
    onlyUserIds?: string[];
  } = {}
): Promise<void> {
  // TS-194: best effort, always. This runs after the change it's about has been saved, so a failure
  // here (a recipient's account deleted a moment ago, the database busy) must never reach the
  // caller and turn a saved change into an error. Each recipient is tried on their own, too, so one
  // failure doesn't stop the others hearing about it.
  try {
    await notifyEveryone(weddingId, actorUserId, type, message, { emailOncePer, emailAtMost, emailMessage, onlyUserIds });
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
    onlyUserIds,
  }: {
    emailOncePer?: { key: string; windowSeconds: number };
    emailAtMost?: { key: string; limit: number; windowSeconds: number };
    emailMessage?: string;
    onlyUserIds?: string[];
  }
): Promise<void> {
  const { rows: weddingRows } = await pool.query(
    `SELECT "ownerId", name, "emailNotificationsEnabled" FROM "weddings" WHERE id = $1`,
    [weddingId]
  );
  const wedding = weddingRows[0];
  if (!wedding) return;

  // TS-213: with each member's own "Email me about this wedding" switch (`wantsEmail`) -- the
  // owner's is on the wedding, a collaborator's on their access row.
  const { rows: everyone } = await pool.query<{ id: string; email: string; emailVerifiedAt: Date | null; wantsEmail: boolean }>(
    `SELECT u.id, u.email, u."emailVerifiedAt", w."ownerEmailNotificationsEnabled" AS "wantsEmail"
       FROM "users" u JOIN "weddings" w ON w."ownerId" = u.id WHERE w.id = $1
     UNION
     SELECT u.id, u.email, u."emailVerifiedAt", wc."emailNotificationsEnabled" AS "wantsEmail" FROM "users" u
     JOIN "wedding_collaborators" wc ON wc."userId" = u.id
     WHERE wc."weddingId" = $1`,
    [weddingId]
  );
  const recipients = onlyUserIds ? everyone.filter((r) => onlyUserIds.includes(r.id)) : everyone;

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
  // TS-213: and not to anyone who has turned these emails off for this wedding.
  const toEmail = notificationEmailRecipients(notified);
  if (toEmail.length === 0) return;

  // TS-186: checked only once there's someone to email, and given back if nobody was emailed --
  // so an event that emailed no one doesn't hold back the next one.
  const gate = await claimEmailGate(emailOncePer, emailAtMost);
  if (!gate.allowed) return;
  let anyEmailed = false;
  try {
    const counters = await notificationEmailCounters(actorUserId, weddingId, wedding.ownerId);
    const weddingName = emailSafeWeddingName(wedding.name);
    // TS-213: the update, then why it came and how to stop it.
    const body = notificationEmailBody({
      text: emailSafeNotificationText(emailMessage ?? message),
      weddingName,
      weddingUrl: weddingPageUrl(weddingId),
    });
    // TS-203: charged to whoever caused it, so it counts toward that account's share of Seatwise's
    // email. TS-219: a guest's answer is not charged to the owner (see notificationEmailCharge).
    const charge = notificationEmailCharge(actorUserId, wedding.ownerId);
    // TS-203: everyone is emailed at the same time (over the shared, pooled mail connection), not
    // one after another -- a guest's RSVP used to wait for each planner's email in turn.
    await Promise.all(
      toEmail.map(async (recipient) => {
        try {
          // TS-194: checked again right before each email -- someone removed from the wedding, or
          // whose account was deleted or changed address, since the list above isn't emailed.
          // TS-213: nor someone who has just turned these emails off.
          const { rows: still } = await pool.query<{ email: string }>(
            `SELECT u.email FROM "users" u
              WHERE u.id = $1 AND u."emailVerifiedAt" IS NOT NULL
                AND (EXISTS (SELECT 1 FROM "weddings" WHERE id = $2 AND "ownerId" = u.id AND "ownerEmailNotificationsEnabled")
                  OR EXISTS (SELECT 1 FROM "wedding_collaborators" WHERE "weddingId" = $2 AND "userId" = u.id AND "emailNotificationsEnabled"))`,
            [recipient.id, weddingId]
          );
          if (!still[0]) return;
          const reservation = await reserveNotificationEmail(counters);
          if (!reservation.allowed) return;
          const result = await sendEmailNotification(
            still[0].email,
            weddingName ? `Seatwise: ${weddingName}` : "Seatwise: a wedding update",
            body,
            // TS-171: a confirmed member of this wedding, so not held to the per-address daily cap.
            { toWeddingMember: true, ...charge }
          );
          // TS-178: nothing went out (failed, held back by the day's limit, or no email service), so it
          // doesn't use up the sender's or the wedding's allowance. TS-203: unless it may have gone
          // out after all ("uncertain"), when it stays counted.
          if (emailMayHaveGone(result)) anyEmailed = true;
          else await reservation.giveBack();
        } catch (err) {
          // TS-194: one recipient's failure is logged; the others are still emailed.
          console.error(`[notify] couldn't email a ${type} notification: ${errorCode(err)}`);
        }
      })
    );
  } finally {
    if (!anyEmailed) await gate.release();
  }
}

/**
 * TS-213: a member's own "Email me about this wedding" switch -- the owner's is on the wedding, a
 * collaborator's on their access row. null when they have no access to the wedding.
 */
export async function getMyEmailNotifications(weddingId: string, userId: string): Promise<boolean | null> {
  const { rows } = await pool.query<{ enabled: boolean }>(
    `SELECT "ownerEmailNotificationsEnabled" AS enabled FROM "weddings" WHERE id = $1 AND "ownerId" = $2
     UNION ALL
     SELECT "emailNotificationsEnabled" AS enabled FROM "wedding_collaborators" WHERE "weddingId" = $1 AND "userId" = $2`,
    [weddingId, userId]
  );
  return rows[0]?.enabled ?? null;
}

/** TS-213: sets that switch. False when they have no access to the wedding (nothing changed). */
export async function setMyEmailNotifications(weddingId: string, userId: string, enabled: boolean): Promise<boolean> {
  const { rowCount: asOwner } = await pool.query(
    `UPDATE "weddings" SET "ownerEmailNotificationsEnabled" = $3 WHERE id = $1 AND "ownerId" = $2`,
    [weddingId, userId, enabled]
  );
  if (asOwner) return true;
  const { rowCount } = await pool.query(
    `UPDATE "wedding_collaborators" SET "emailNotificationsEnabled" = $3 WHERE "weddingId" = $1 AND "userId" = $2`,
    [weddingId, userId, enabled]
  );
  return (rowCount ?? 0) > 0;
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
