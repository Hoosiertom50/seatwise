import { randomUUID } from "crypto";
import { isRsvpCutoffPast } from "@seatwise/shared";
import { pool } from "../pool";
import { encryptText, decryptText } from "../crypto";
import {
  applyAttendanceChange,
  lockCurrentPlan,
  recordRecheckIfApproved,
  refreshPlanCompleteness,
  resyncTables,
  tablesAffectedBy,
  type TableSeatingFlagReason,
} from "./seat-checks";
import { hashLinkToken, isPlainStoredLinkToken, newLinkToken, readStoredLinkToken } from "../link-tokens";

export interface GuestRow {
  id: string;
  weddingId: string;
  firstName: string;
  lastName: string;
  partyName: string | null;
  headcount: number;
  tier: string;
  rsvpStatus: string;
  requiresAccessibleTable: boolean;
  isLocked: boolean;
  dayOfAttendance: string;
  notes: string | null;
  // FR-3.4
  side: string;
  // FR-3.7
  ageCategory: string;
  // FR-3.7a: the Restricted table this guest is a required member of, if any.
  requiredTableId: string | null;
  // TS-17 (FR-12.4): lets a planner actually deliver (or resend) this guest's own RSVP link.
  email: string | null;
  // TS-17 (FR-12.1): free-text "who's coming with you", only meaningful when headcount > 1.
  plusOneNames: string | null;
  // TS-17: set only by the guest's own public submission (submitGuestRsvp below), never by a
  // planner editing the guest directly.
  rsvpRespondedAt: Date | null;
  // TS-107: the guest's own RSVP-form note, separate from the planner's private `notes`.
  rsvpNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
  // FR-7.7: an optimistic-concurrency counter for this guest -- an edit that names an
  // expectedRevision the server no longer matches is rejected as stale.
  revision: number;
}

// Joined against restricted_table_guests so every read can surface requiredTableId (FR-3.7a)
// without a second round-trip; a plain INSERT ... RETURNING can't do that join, so createGuest
// below fills it in as null itself (a brand-new guest can't already be on a required list).
// Deliberately excludes g."rsvpToken" -- the raw token is never returned by any of these general
// reads (see the dedicated rsvp-link queries below), so a COMMENT/VIEW-level collaborator (or a
// bug in a lower-privilege view) can never see a guest's secret RSVP link through this path.
const COLUMNS = `g.id, g."weddingId", g."firstName", g."lastName", g."partyName", g.headcount, g.tier,
  g."rsvpStatus", g."requiresAccessibleTable", g."isLocked", g."dayOfAttendance", g.notes, g.side,
  g."ageCategory", g.email, g."plusOneNames", g."rsvpRespondedAt", g."rsvpNotes", g.revision,
  rtg."tableId" AS "requiredTableId", g."createdAt", g."updatedAt"`;
// TS-165: only lists on tables that are still Restricted count.
const FROM_JOINED = `FROM "guests" g LEFT JOIN "restricted_table_guests" rtg ON rtg."guestId" = g.id
  AND EXISTS (SELECT 1 FROM "seating_tables" rt WHERE rt.id = rtg."tableId" AND rt."isRestricted")`;

// NFR-9.3b / TS-107: both free-text note columns are encrypted at rest -- every read decrypts both.
function decryptGuestNotes<T extends { notes: string | null; rsvpNotes: string | null }>(row: T): T {
  return { ...row, notes: decryptText(row.notes), rsvpNotes: decryptText(row.rsvpNotes) };
}

// FR-7.7: thrown instead of applying an edit whose expectedRevision no longer matches the guest's
// current one -- the fresh, up-to-date guest is attached so the caller can refresh the UI with it
// directly rather than making a second round-trip.
export class GuestConflictError extends Error {
  guest: GuestRow;
  constructor(message: string, guest: GuestRow) {
    super(message);
    this.guest = guest;
  }
}

export interface CreateGuestData {
  firstName: string;
  lastName: string;
  partyName?: string | null;
  headcount?: number;
  tier?: string;
  rsvpStatus?: string;
  requiresAccessibleTable?: boolean;
  isLocked?: boolean;
  dayOfAttendance?: string;
  notes?: string | null;
  side?: string;
  ageCategory?: string;
  email?: string | null;
  plusOneNames?: string | null;
}

// NFR-9.3b: `notes` is where free-text dietary/accessibility details actually end up, so it's the
// one guest field encrypted at rest (see crypto.ts) — encrypted on the way in here, decrypted on
// the way back out in every read below.
export async function createGuest(weddingId: string, input: CreateGuestData): Promise<GuestRow> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO "guests"
       (id, "weddingId", "firstName", "lastName", "partyName", headcount, tier, "rsvpStatus", "requiresAccessibleTable", "isLocked", "dayOfAttendance", notes, side, "ageCategory", email, "plusOneNames", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
     RETURNING id, "weddingId", "firstName", "lastName", "partyName", headcount, tier,
               "rsvpStatus", "requiresAccessibleTable", "isLocked", "dayOfAttendance", notes, side,
               "ageCategory", email, "plusOneNames", "rsvpRespondedAt", "rsvpNotes", revision, "createdAt", "updatedAt"`,
    [
      id,
      weddingId,
      input.firstName,
      input.lastName,
      input.partyName ?? null,
      input.headcount ?? 1,
      input.tier ?? "OTHER",
      input.rsvpStatus ?? "PENDING",
      input.requiresAccessibleTable ?? false,
      input.isLocked ?? false,
      input.dayOfAttendance ?? "ATTENDING",
      encryptText(input.notes ?? null),
      input.side ?? "BOTH",
      input.ageCategory ?? "ADULT",
      input.email ?? null,
      input.plusOneNames ?? null,
    ]
  );
  return { ...decryptGuestNotes(rows[0]), requiredTableId: null };
}

export async function listGuestsByWedding(weddingId: string): Promise<GuestRow[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} ${FROM_JOINED} WHERE g."weddingId" = $1 ORDER BY g."lastName", g."firstName"`,
    [weddingId]
  );
  return rows.map(decryptGuestNotes);
}

export async function getGuestForWedding(id: string, weddingId: string): Promise<GuestRow | null> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} ${FROM_JOINED} WHERE g.id = $1 AND g."weddingId" = $2`,
    [id, weddingId]
  );
  if (!rows[0]) return null;
  return decryptGuestNotes(rows[0]);
}

// FR-7.7, extended to guests: an optional expectedRevision locks the guest's row (FOR UPDATE,
// inside this function's own transaction) and compares it against the current revision before
// writing anything. A mismatch means someone else's edit landed first -- rather than proceeding
// on stale data, this throws GuestConflictError with the fresh, currently-committed guest attached
// (a plain read from a second connection isn't blocked by the row lock, so it safely sees the
// latest committed state) and writes nothing. A caller that passes no expectedRevision at all
// (an internal/legacy call site) skips the check entirely, matching the plan-version pattern.
export async function updateGuestForWedding(
  id: string,
  weddingId: string,
  input: Partial<CreateGuestData>,
  expectedRevision?: number
): Promise<boolean> {
  const columnMap: Record<string, string> = {
    firstName: `"firstName"`,
    lastName: `"lastName"`,
    partyName: `"partyName"`,
    headcount: `headcount`,
    tier: `tier`,
    rsvpStatus: `"rsvpStatus"`,
    requiresAccessibleTable: `"requiresAccessibleTable"`,
    isLocked: `"isLocked"`,
    dayOfAttendance: `"dayOfAttendance"`,
    notes: `notes`,
    side: `side`,
    ageCategory: `"ageCategory"`,
    email: `email`,
    plusOneNames: `"plusOneNames"`,
  };
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, column] of Object.entries(columnMap)) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) {
      fields.push(`${column} = $${i++}`);
      values.push(key === "notes" ? encryptText(value as string | null) : value);
    }
  }
  // TS-154: a planner setting the party size makes that the guest's new limit.
  if (input.headcount !== undefined) fields.push(`"partySizeLimit" = NULL`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT revision FROM "guests" WHERE id = $1 AND "weddingId" = $2 FOR UPDATE`,
      [id, weddingId]
    );
    const current = rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return false;
    }
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      const fresh = await getGuestForWedding(id, weddingId);
      throw new GuestConflictError(
        "This guest changed since you loaded it (maybe in another tab, or by someone else). It's been refreshed with the latest — check it and make your change again if it's still needed.",
        fresh!
      );
    }
    if (fields.length > 0) {
      fields.push(`"updatedAt" = now()`, `revision = revision + 1`);
      values.push(id, weddingId);
      await client.query(
        `UPDATE "guests" SET ${fields.join(", ")} WHERE id = $${i++} AND "weddingId" = $${i}`,
        values
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteGuestForWedding(id: string, weddingId: string, actorUserId?: string): Promise<boolean> {
  // TS-165: their seat and seating rules go with them, which can clear flags on other guests -- a
  // must-sit-together partner now seated alone, a table that now has room. Re-check those tables
  // in the same transaction (the caller already recounts completeness).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // TS-173: the current plan's row first, then the guest's (see lockCurrentPlan).
    const planVersionId = await lockCurrentPlan(client, weddingId);
    const affected = planVersionId ? await tablesAffectedBy(client, weddingId, planVersionId, [id]) : [];
    // TS-169: whether they had a seat, and their name, for the plan's history (read before the delete).
    const { rows: seated } = planVersionId
      ? await client.query(
          `SELECT (g."firstName" || ' ' || g."lastName") AS name FROM "seat_assignments" sa JOIN "guests" g ON g.id = sa."guestId"
           WHERE sa."planVersionId" = $1 AND sa."guestId" = $2`,
          [planVersionId, id]
        )
      : { rows: [] as { name: string }[] };
    const { rowCount } = await client.query(`DELETE FROM "guests" WHERE id = $1 AND "weddingId" = $2`, [
      id,
      weddingId,
    ]);
    const deleted = (rowCount ?? 0) > 0;
    if (deleted && planVersionId && affected.length > 0) {
      const { changed } = await resyncTables(client, weddingId, planVersionId, affected);
      await refreshPlanCompleteness(client, weddingId, planVersionId, { bumpRevision: changed || seated.length > 0 });
    }
    // TS-169: removing a seated guest changes an approved plan -- it shows "Modified since approval".
    if (deleted && planVersionId && seated[0]) {
      await recordRecheckIfApproved(client, planVersionId, `${seated[0].name} was removed from the guest list (and their seat)`, actorUserId ?? null);
    }
    await client.query("COMMIT");
    return deleted;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// TS-17: the guest-facing RSVP flow -- looked up by the opaque token alone (never a
// weddingId + guestId pair), mirroring the invite-token pattern in invites.ts.

export interface GuestRsvpLookupRow {
  id: string;
  weddingId: string;
  weddingName: string;
  firstName: string;
  lastName: string;
  headcount: number;
  // TS-154: the most people this guest may RSVP for.
  partySizeLimit: number;
  rsvpStatus: string;
  plusOneNames: string | null;
  // TS-107: the guest's own RSVP note only. The planner's private `notes` is deliberately never
  // selected on this unauthenticated path -- an RSVP link is meant to be emailed and forwarded.
  rsvpNotes: string | null;
  requiresAccessibleTable: boolean;
  // FR-12.2: null means no cutoff at all -- the caller never treats a null cutoff as "closed".
  rsvpCutoffDate: string | null;
}

export async function getGuestByRsvpToken(token: string): Promise<GuestRsvpLookupRow | null> {
  const { rows } = await pool.query(
    `SELECT g.id, g."weddingId", w.name AS "weddingName", g."firstName", g."lastName",
            g.headcount, COALESCE(g."partySizeLimit", g.headcount) AS "partySizeLimit",
            g."rsvpStatus", g."plusOneNames", g."rsvpNotes",
            g."requiresAccessibleTable", w."rsvpCutoffDate"::text AS "rsvpCutoffDate"
     FROM "guests" g JOIN "weddings" w ON w.id = g."weddingId"
     WHERE g."rsvpTokenHash" = $1`,
    [hashLinkToken(token)]
  );
  if (!rows[0]) return null;
  return { ...rows[0], rsvpNotes: decryptText(rows[0].rsvpNotes) };
}

// FR-12.4: idempotent -- most guests, especially bulk-imported ones, may never need a link at
// all, so a token is only ever generated the first time someone asks for one. Returns null only
// if the guest doesn't exist (belongs to a different wedding, or was deleted).
export async function ensureGuestRsvpToken(guestId: string, weddingId: string): Promise<string | null> {
  // TS-153: one statement, so an automatic RSVP email and a click on "RSVP link" at the same moment
  // both get the same link -- before, the second could replace the one just emailed.
  // TS-160: looked up by its hash; the encrypted copy is what lets this show the same link again.
  const fresh = newLinkToken();
  const { rows } = await pool.query(
    `UPDATE "guests" SET "rsvpToken" = COALESCE("rsvpToken", $3), "rsvpTokenHash" = COALESCE("rsvpTokenHash", $4)
     WHERE id = $1 AND "weddingId" = $2
     RETURNING "rsvpToken"`,
    [guestId, weddingId, fresh.encrypted, fresh.hash]
  );
  const stored: string | null = rows[0]?.rsvpToken ?? null;
  if (stored && isPlainStoredLinkToken(stored)) {
    // A link made before TS-160: keep it working, but stop storing it in plain text.
    await pool.query(`UPDATE "guests" SET "rsvpToken" = $1 WHERE id = $2 AND "rsvpToken" = $3`, [
      encryptText(stored),
      guestId,
      stored,
    ]);
  }
  return readStoredLinkToken(stored);
}

// TS-174: whether this guest has ever been given an RSVP link (a link may be out there).
export async function guestHasRsvpLink(guestId: string, weddingId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM "guests" WHERE id = $1 AND "weddingId" = $2 AND "rsvpTokenHash" IS NOT NULL`,
    [guestId, weddingId]
  );
  return rows.length > 0;
}

// FR-12.4: "regenerate" -- always issues a fresh token, invalidating whatever link was out there
// before (e.g. a planner suspects a link was shared somewhere it shouldn't have been).
export async function regenerateGuestRsvpToken(guestId: string, weddingId: string): Promise<string | null> {
  const fresh = newLinkToken();
  const { rowCount } = await pool.query(
    `UPDATE "guests" SET "rsvpToken" = $1, "rsvpTokenHash" = $2 WHERE id = $3 AND "weddingId" = $4`,
    [fresh.encrypted, fresh.hash, guestId, weddingId]
  );
  return (rowCount ?? 0) > 0 ? fresh.token : null;
}

// FR-12.1/FR-12.2/FR-12.3: thrown instead of applying a guest's own RSVP submission when their
// token doesn't exist at all, or the wedding's rsvpCutoffDate has already passed.
export class RsvpSubmissionError extends Error {
  constructor(
    message: string,
    public code: "NOT_FOUND" | "CLOSED" | "OVER_PARTY_SIZE"
  ) {
    super(message);
    this.name = "RsvpSubmissionError";
  }
}

export interface SubmitGuestRsvpData {
  rsvpStatus: string;
  headcount?: number;
  plusOneNames?: string | null;
  // TS-107: stored in rsvpNotes, never in the planner's own `notes`.
  rsvpNotes?: string | null;
  requiresAccessibleTable?: boolean;
}

// TS-174: what a guest's own RSVP did, beyond saving their answer -- for the route's message.
export interface GuestRsvpResult extends GuestRow {
  previousRsvpStatus: string;
  /** Their attendance moved because their answer changed (TS-167/TS-169), or null. */
  attendanceChange: "ATTENDING" | "NOT_ATTENDING" | null;
  /** They gave up a seat they actually had (not just "marked not attending"). */
  seatFreed: boolean;
  /** Seated guests the answer flagged Needs Reassignment (TS-134). */
  newlyFlagged: { name: string; reason: TableSeatingFlagReason }[];
}

// FR-12.1/FR-12.3: writes directly into the guest's own record (never a separate copy) and bumps
// revision so any planner concurrently viewing this guest gets a correct conflict signal on their
// own next save -- but deliberately takes no expectedRevision itself: an unauthenticated public
// form has no "last loaded revision" of its own to send back. rsvpRespondedAt is set here and only
// here, which is what makes it mean "responded via their own link" (FR-12.4) rather than anything
// a planner's direct edit could also produce.
// TS-169: also returns the answer they had before this one, so the caller can tell a real change
// of mind (Declined -> Confirmed) from re-sending the same answer to fix a detail.
// TS-174: one transaction, all of it. Before, the link, party-size limit and cutoff were read in
// one statement and the answer written in another by guest id -- so a link regenerated (or a limit
// lowered) in between still took the answer and put the old limit back, and a guest deleted in
// between gave a server error. Now the guest's row is locked *by its link* and everything is
// checked under that lock; and the attendance change a changed answer brings (TS-167/TS-169) and
// the re-check of their seat (TS-134) are part of the same write. Locks are taken in the usual
// order (wedding, current plan, guest -- see lockCurrentPlan).
export async function submitGuestRsvp(token: string, input: SubmitGuestRsvpData): Promise<GuestRsvpResult> {
  const tokenHash = hashLinkToken(token);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Which wedding to lock -- read without a lock, then checked again under it below.
    const { rows: found } = await client.query<{ weddingId: string }>(
      `SELECT "weddingId" FROM "guests" WHERE "rsvpTokenHash" = $1`,
      [tokenHash]
    );
    if (!found[0]) throw new RsvpSubmissionError("This RSVP link isn't valid.", "NOT_FOUND");
    const weddingId = found[0].weddingId;
    const { rows: weddingRows } = await client.query<{ rsvpCutoffDate: string | null }>(
      `SELECT "rsvpCutoffDate"::text AS "rsvpCutoffDate" FROM "weddings" WHERE id = $1 FOR UPDATE`,
      [weddingId]
    );
    if (!weddingRows[0]) throw new RsvpSubmissionError("This RSVP link isn't valid.", "NOT_FOUND");
    const planVersionId = await lockCurrentPlan(client, weddingId);
    const { rows: locked } = await client.query<{
      id: string;
      name: string;
      rsvpStatus: string;
      dayOfAttendance: string;
      partySizeLimit: number;
    }>(
      `SELECT id, ("firstName" || ' ' || "lastName") AS name, "rsvpStatus", "dayOfAttendance",
              COALESCE("partySizeLimit", headcount) AS "partySizeLimit"
       FROM "guests" WHERE "rsvpTokenHash" = $1 AND "weddingId" = $2 FOR UPDATE`,
      [tokenHash, weddingId]
    );
    const guest = locked[0];
    // A new link was made, or the guest removed, while this was on its way.
    if (!guest) throw new RsvpSubmissionError("This RSVP link isn't valid.", "NOT_FOUND");

    // FR-12.2: the cutoff is a date, not a timestamp -- responses are accepted through the entire
    // cutoff day itself, only actually closing off at the start of the next day.
    // TS-153: the day ends when it has ended everywhere (see @seatwise/shared rsvp-cutoff.ts).
    if (isRsvpCutoffPast(weddingRows[0].rsvpCutoffDate)) {
      throw new RsvpSubmissionError("RSVP responses have closed for this wedding.", "CLOSED");
    }

    // TS-174: only the answers the form actually asks for are saved. Declining hides the party
    // size, plus-ones and accessible seat, so those stay as they were on file (and a re-confirm
    // starts from them); a party of one has no plus-ones to name, so any are cleared. This holds
    // whatever is sent, so the API can't store an answer the form never showed.
    const confirming = input.rsvpStatus === "CONFIRMED";
    const headcount = input.headcount ?? 1;
    // TS-154 (Tom's decision #2): a guest can answer for at most the party size the planner set.
    const limit = Number(guest.partySizeLimit);
    if (confirming && headcount > limit) {
      throw new RsvpSubmissionError(
        `Your invitation is for up to ${limit} ${limit === 1 ? "person" : "people"}. Contact the couple if you need to bring more.`,
        "OVER_PARTY_SIZE"
      );
    }

    await client.query(
      confirming
        ? `UPDATE "guests"
           SET "rsvpStatus" = $1, "rsvpNotes" = $2, "rsvpRespondedAt" = now(), "updatedAt" = now(),
               "partySizeLimit" = $3, revision = revision + 1,
               headcount = $5, "plusOneNames" = $6, "requiresAccessibleTable" = $7
           WHERE id = $4`
        : `UPDATE "guests"
           SET "rsvpStatus" = $1, "rsvpNotes" = $2, "rsvpRespondedAt" = now(), "updatedAt" = now(),
               "partySizeLimit" = $3, revision = revision + 1
           WHERE id = $4`,
      [
        input.rsvpStatus,
        encryptText(input.rsvpNotes ?? null),
        limit,
        guest.id,
        ...(confirming
          ? [headcount, headcount > 1 ? (input.plusOneNames ?? null) : null, input.requiresAccessibleTable ?? false]
          : []),
      ]
    );

    // TS-167 (Tom, 2026-10-05): a guest who declines gives up their seat -- they're marked Not
    // Attending, which frees it and re-checks the table, as on the day. If they confirm again
    // later, they count as attending again and wait, unseated, for the planner to seat them.
    // TS-169: only on an actual change of answer. Sending the same answer again (to fix a
    // plus-one's name, say) leaves alone whatever the planner has set for their attendance.
    const changedAnswer = guest.rsvpStatus !== input.rsvpStatus;
    let attendanceChange: GuestRsvpResult["attendanceChange"] = null;
    if (changedAnswer && input.rsvpStatus === "DECLINED" && guest.dayOfAttendance === "ATTENDING") {
      attendanceChange = "NOT_ATTENDING";
    } else if (changedAnswer && guest.rsvpStatus === "DECLINED" && confirming && guest.dayOfAttendance === "NOT_ATTENDING") {
      attendanceChange = "ATTENDING";
    }
    let seatFreed = false;
    if (attendanceChange) {
      ({ seatFreed } = await applyAttendanceChange(
        client,
        weddingId,
        planVersionId,
        { id: guest.id, name: guest.name },
        attendanceChange,
        null
      ));
    }

    // TS-134: a guest who now needs an accessible seat, or is bringing more people than their
    // table has room for, is flagged Needs Reassignment -- exactly as a planner's own edit would --
    // instead of silently staying where they no longer fit.
    let newlyFlagged: GuestRsvpResult["newlyFlagged"] = [];
    if (planVersionId) {
      const { rows: seatedAt } = await client.query<{ tableId: string }>(
        `SELECT "seatingTableId" AS "tableId" FROM "seat_assignments" WHERE "planVersionId" = $1 AND "guestId" = $2`,
        [planVersionId, guest.id]
      );
      if (seatedAt.length > 0) {
        const result = await resyncTables(client, weddingId, planVersionId, seatedAt.map((r) => r.tableId));
        newlyFlagged = result.newlyFlagged.map(({ name, reason }) => ({ name, reason }));
        await refreshPlanCompleteness(client, weddingId, planVersionId, { bumpRevision: result.changed });
        if (result.changed) {
          await recordRecheckIfApproved(client, planVersionId, "Seating re-checked after a change — some guests' Needs Reassignment flags changed", null);
        }
      }
    }

    const { rows: saved } = await client.query(`SELECT ${COLUMNS} ${FROM_JOINED} WHERE g.id = $1`, [guest.id]);
    await client.query("COMMIT");
    return {
      ...decryptGuestNotes(saved[0] as GuestRow),
      previousRsvpStatus: guest.rsvpStatus,
      attendanceChange,
      seatFreed,
      newlyFlagged,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
