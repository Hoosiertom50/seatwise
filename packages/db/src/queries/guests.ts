import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { isRsvpCutoffPast, plusOnesForParty } from "@seatwise/shared";
import { pool, beginTransaction } from "../pool";
import { encryptText, decryptText } from "../crypto";
import {
  applyAttendanceChange,
  lockCurrentPlan,
  lockRestrictedLists,
  recordRecheckIfApproved,
  refreshPlanCompleteness,
  resyncTables,
  restrictedListsOverCapacity,
  tablesAffectedBy,
  requiredAtNonAccessibleTable,
  type TableSeatingFlagReason,
} from "./seat-checks";
import { hashLinkToken, isPlainStoredLinkToken, newLinkToken, readStoredLinkToken } from "../link-tokens";
import { inWeddingChange, lockWeddingRow, recheckActorAccess, type ActorAccess } from "./wedding-lock";
import { assertWeddingHasRoom } from "./wedding-caps";
import { AttendanceError } from "./plan-versions";

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

// TS-181: thrown instead of saving a party size that a guest's Restricted table can't hold for
// its required-guest list. Nothing is saved.
export class GuestHeadcountError extends Error {}

// TS-188: thrown instead of marking a guest as needing an accessible table while they're on the
// required-guest list of a Restricted table that isn't accessible -- the only table they'd be
// allowed at would be one they can't use. Nothing is saved.
export class GuestAccessibleTableError extends Error {}

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
// TS-204: the person's access is read again as the guest is saved (see inWeddingChange).
// TS-205: and the wedding's guest cap checked under the wedding's lock (see wedding-caps.ts).
export async function createGuest(weddingId: string, input: CreateGuestData, actor?: ActorAccess): Promise<GuestRow> {
  return inWeddingChange(
    weddingId,
    actor,
    async (q) => {
      await assertWeddingHasRoom(q, weddingId, "guests", 1);
      return insertGuest(q, weddingId, input);
    },
    { lockWedding: true }
  );
}

async function insertGuest(q: PoolClient, weddingId: string, input: CreateGuestData): Promise<GuestRow> {
  const id = randomUUID();
  const { rows } = await q.query(
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
      // TS-202: a party of one has no plus-ones.
      plusOnesForParty(input.headcount ?? 1, input.plusOneNames),
    ]
  );
  return { ...decryptGuestNotes(rows[0]), requiredTableId: null };
}

export async function listGuestsByWedding(weddingId: string): Promise<GuestRow[]> {
  // TS-196: g.id breaks ties between guests with the same name, so they always come back in the
  // same order (and generating a plan from them always gives the same result).
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} ${FROM_JOINED} WHERE g."weddingId" = $1 ORDER BY g."lastName", g."firstName", g.id`,
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

// TS-195: what a guest edit did to the guest's attendance, beyond saving the fields -- for the
// route's message and notification (attendanceChange is null when it didn't change it).
export interface GuestUpdateResult {
  attendanceChange: "ATTENDING" | "NOT_ATTENDING" | null;
  /** They gave up a seat they actually had. */
  seatFreed: boolean;
  /** The guest's name, as saved (for the route's notification). */
  guestName: string;
  /** The current plan when the change was saved, if there is one. */
  planVersionId: string | null;
}

// FR-7.7, extended to guests: an optional expectedRevision locks the guest's row (FOR UPDATE,
// inside this function's own transaction) and compares it against the current revision before
// writing anything. A mismatch means someone else's edit landed first -- rather than proceeding
// on stale data, this throws GuestConflictError with the fresh, currently-committed guest attached
// (a plain read from a second connection isn't blocked by the row lock, so it safely sees the
// latest committed state) and writes nothing. A caller that passes no expectedRevision at all
// (an internal/legacy call site) skips the check entirely, matching the plan-version pattern.
// TS-195: the attendance change an edit brings is now part of the same transaction -- an explicit
// dayOfAttendance, or the one a change of RSVP answer brings (Declined -> Not Attending, which
// frees their seat; back from Declined -> Attending again, waiting for a seat; TS-167/TS-169).
// It's decided from the guest's row as it is under the lock, not from a copy read before. Before,
// the route saved the fields, then changed attendance in a second transaction, deciding from the
// answer it had read before either: so a guest's own RSVP landing in between could leave someone
// Confirmed but Not Attending (or the mirror), a failed seat release couldn't be retried (the
// answer was already saved), and refusing to bring someone back answered 422 after the rest of
// the edit had already been saved. Now a refusal refuses the whole edit, and nothing is saved.
// Returns null if there's no such guest.
export async function updateGuestForWedding(
  id: string,
  weddingId: string,
  input: Partial<CreateGuestData>,
  expectedRevision?: number,
  /** TS-195: who made the edit, for the plan's history of an attendance change. */
  actorUserId: string | null = null,
  /** TS-204: the access the edit was let in with -- read again under the edit's first lock. */
  actor?: ActorAccess
): Promise<GuestUpdateResult | null> {
  const columnMap: Record<string, string> = {
    firstName: `"firstName"`,
    lastName: `"lastName"`,
    partyName: `"partyName"`,
    headcount: `headcount`,
    tier: `tier`,
    rsvpStatus: `"rsvpStatus"`,
    requiresAccessibleTable: `"requiresAccessibleTable"`,
    isLocked: `"isLocked"`,
    // TS-195: dayOfAttendance isn't written here -- it goes through applyAttendanceChange below,
    // which frees the seat and keeps the plan in step.
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

  // TS-195: an edit that can change the guest's attendance -- one that sets it, or changes their
  // RSVP answer -- takes the wedding's lock first, as setGuestAttendance and a guest's own RSVP do,
  // so it and a guest answering by link at the same moment take turns.
  const mayChangeAttendance = input.dayOfAttendance !== undefined || input.rsvpStatus !== undefined;
  // Bringing someone back to Attending is checked against their Restricted table's list, and so
  // are a bigger party and needing an accessible table -- those take the lists' lock.
  const mayBringBack =
    input.dayOfAttendance === "ATTENDING" || (input.rsvpStatus !== undefined && input.rsvpStatus !== "DECLINED");
  const checksLists = input.headcount !== undefined || input.requiresAccessibleTable !== undefined || mayBringBack;

  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-187/TS-195: the locks in the usual order -- the wedding (when attendance may change), the
    // current plan, the Restricted tables' lists -- before the guest's row. Before, an edit of
    // whether a guest needs an accessible table locked the guest first and the tables after, the
    // other way round from saving a list, so the two could each wait for the other.
    if (mayChangeAttendance) await lockWeddingRow(client, weddingId);
    let planVersionId: string | null = null;
    if (mayChangeAttendance || checksLists) planVersionId = await lockCurrentPlan(client, weddingId);
    if (checksLists) await lockRestrictedLists(client, weddingId);
    // TS-204: the person's access read again, under the locks above -- lowered or removed while
    // this waited: refused, nothing saved.
    if (actor) await recheckActorAccess(client, weddingId, actor);
    const { rows } = await client.query<{
      revision: number;
      headcount: number;
      rsvpStatus: string;
      dayOfAttendance: string;
      name: string;
    }>(
      // TS-187: NO KEY UPDATE -- see resyncSeatsAtTable in seat-checks.ts.
      `SELECT revision, headcount, "rsvpStatus", "dayOfAttendance", ("firstName" || ' ' || "lastName") AS name
       FROM "guests" WHERE id = $1 AND "weddingId" = $2 FOR NO KEY UPDATE`,
      [id, weddingId]
    );
    const current = rows[0];
    if (!current) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      // TS-187: the locks are let go before the fresh copy is read on another connection.
      await client.query("ROLLBACK").catch(() => {});
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
      // TS-202: an edit that leaves the guest a party of one leaves them no plus-ones (the names
      // used to stay -- shown on the Guests tab, hidden from the export and printouts). Part of the
      // same edit, so the revision isn't moved on twice.
      if (input.headcount !== undefined || input.plusOneNames !== undefined) {
        await client.query(
          `UPDATE "guests" SET "plusOneNames" = NULL WHERE id = $1 AND headcount <= 1 AND "plusOneNames" IS NOT NULL`,
          [id]
        );
      }
    }

    // TS-195: the attendance this edit leaves them at, from the row as it is under the lock.
    // An attendance given in the edit wins; otherwise a change of answer brings its own (TS-167:
    // marking them Declined frees their seat, the same as when they decline themselves; TS-169:
    // changing them back from Declined brings them back -- Attending, waiting for a seat).
    let attendance: "ATTENDING" | "NOT_ATTENDING" | null = null;
    if (input.dayOfAttendance !== undefined) {
      attendance = input.dayOfAttendance as "ATTENDING" | "NOT_ATTENDING";
    } else if (input.rsvpStatus === "DECLINED" && current.rsvpStatus !== "DECLINED") {
      attendance = "NOT_ATTENDING";
    } else if (input.rsvpStatus !== undefined && input.rsvpStatus !== "DECLINED" && current.rsvpStatus === "DECLINED") {
      attendance = "ATTENDING";
    }
    let attendanceChange: GuestUpdateResult["attendanceChange"] = null;
    let seatFreed = false;
    // The name as this edit leaves it, for the plan's history and the messages.
    const { rows: savedName } = await client.query<{ name: string }>(
      `SELECT ("firstName" || ' ' || "lastName") AS name FROM "guests" WHERE id = $1`,
      [id]
    );
    const name = savedName[0]?.name ?? current.name;
    if (attendance && attendance !== current.dayOfAttendance) {
      attendanceChange = attendance;
      ({ seatFreed } = await applyAttendanceChange(client, weddingId, planVersionId, { id, name }, attendance, actorUserId));
    }

    // TS-181: a guest on a Restricted table's required-guest list can only grow their party while
    // the list still fits the table -- otherwise there'd be nowhere they're allowed to sit.
    if (input.headcount !== undefined && input.headcount > current.headcount) {
      const [over] = await restrictedListsOverCapacity(client, [id]);
      if (over) {
        throw new GuestHeadcountError(
          `${over.guestNames[0] ?? "This guest"} is on "${over.tableLabel}"'s required-guest list, and a party of ${input.headcount} would need ${over.seats} seats there — it has ${over.capacity}. Give that table more seats, or take them off its list first.`
        );
      }
    }
    // TS-188: Restricted lists count only attending guests, so someone coming back counts again --
    // the planner can't bring them back if their table's list would then need more seats than it
    // has. TS-195: refused as part of the whole edit, so nothing of it is saved.
    if (attendanceChange === "ATTENDING") {
      const [over] = await restrictedListsOverCapacity(client, [id]);
      if (over) {
        throw new AttendanceError(
          `${name} is on "${over.tableLabel}"'s required-guest list, which would then need ${over.seats} seats — it has ${over.capacity}. Give that table more seats, or take someone off its list first.`
        );
      }
    }
    // TS-188: nor can they be marked as needing an accessible table while they're required at a
    // Restricted table that isn't accessible -- the only table they're allowed at would be one
    // they can't use. (The same check the table's list already makes from the other side.)
    if (input.requiresAccessibleTable === true) {
      const [clash] = await requiredAtNonAccessibleTable(client, [id]);
      if (clash) {
        throw new GuestAccessibleTableError(
          `${clash.guestName} is on "${clash.tableLabel}"'s required-guest list, and "${clash.tableLabel}" isn't marked Accessible — mark it Accessible first, or take them off its list.`
        );
      }
    }
    await client.query("COMMIT");
    return { attendanceChange, seatFreed, guestName: name, planVersionId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteGuestForWedding(
  id: string,
  weddingId: string,
  actorUserId?: string,
  /** TS-204: the access the delete was let in with -- read again under its first lock. */
  actor?: ActorAccess
): Promise<boolean> {
  // TS-165: their seat and seating rules go with them, which can clear flags on other guests -- a
  // must-sit-together partner now seated alone, a table that now has room. Re-check those tables
  // in the same transaction (the caller already recounts completeness).
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-173: the current plan's row first, then the guest's (see lockCurrentPlan).
    const planVersionId = await lockCurrentPlan(client, weddingId);
    // TS-204: the person's access read again under that lock.
    if (actor) await recheckActorAccess(client, weddingId, actor);
    const affected = planVersionId ? await tablesAffectedBy(client, weddingId, planVersionId, [id]) : [];
    // TS-169: whether they had a seat, and their name, for the plan's history (read before the delete).
    const { rows: seated } = planVersionId
      ? await client.query(
          `SELECT (g."firstName" || ' ' || g."lastName") AS name FROM "seat_assignments" sa JOIN "guests" g ON g.id = sa."guestId"
           WHERE sa."planVersionId" = $1 AND sa."guestId" = $2`,
          [planVersionId, id]
        )
      : { rows: [] as { name: string }[] };
    // TS-197: whether they were attending -- an attending guest leaving changes the plan's list of
    // guests waiting for a seat, so the plan moves on a revision here, once (the route's follow-up
    // recount used to move it on a second time).
    const { rows: deletedRows } = await client.query(
      `DELETE FROM "guests" WHERE id = $1 AND "weddingId" = $2 RETURNING "dayOfAttendance"`,
      [id, weddingId]
    );
    const deleted = deletedRows.length > 0;
    const wasAttending = deletedRows[0]?.dayOfAttendance === "ATTENDING";
    if (deleted && planVersionId) {
      const { changed } = affected.length > 0 ? await resyncTables(client, weddingId, planVersionId, affected) : { changed: false };
      await refreshPlanCompleteness(client, weddingId, planVersionId, {
        bumpRevision: changed || seated.length > 0 || wasAttending,
      });
    }
    // TS-169: removing a seated guest changes an approved plan -- it shows "Modified since approval".
    if (deleted && planVersionId && seated[0]) {
      await recordRecheckIfApproved(client, planVersionId, `${seated[0].name} was removed from the guest list (and their seat)`, actorUserId ?? null);
    }
    await client.query("COMMIT");
    return deleted;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
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
export async function ensureGuestRsvpToken(guestId: string, weddingId: string, actor?: ActorAccess): Promise<string | null> {
  // TS-204: with the person's access read again as the link is made (see inWeddingChange) -- a
  // link is a way into the wedding's RSVP, so someone removed a moment ago mustn't get one.
  return inWeddingChange(weddingId, actor, (q) => ensureGuestRsvpTokenIn(q, guestId, weddingId));
}

async function ensureGuestRsvpTokenIn(q: PoolClient, guestId: string, weddingId: string): Promise<string | null> {
  // TS-153: one statement, so an automatic RSVP email and a click on "RSVP link" at the same moment
  // both get the same link -- before, the second could replace the one just emailed.
  // TS-160: looked up by its hash; the encrypted copy is what lets this show the same link again.
  const fresh = newLinkToken();
  const { rows } = await q.query(
    `UPDATE "guests" SET "rsvpToken" = COALESCE("rsvpToken", $3), "rsvpTokenHash" = COALESCE("rsvpTokenHash", $4)
     WHERE id = $1 AND "weddingId" = $2
     RETURNING "rsvpToken"`,
    [guestId, weddingId, fresh.encrypted, fresh.hash]
  );
  const stored = (rows[0]?.rsvpToken as string | null | undefined) ?? null;
  if (stored && isPlainStoredLinkToken(stored)) {
    // A link made before TS-160: keep it working, but stop storing it in plain text.
    await q.query(`UPDATE "guests" SET "rsvpToken" = $1 WHERE id = $2 AND "rsvpToken" = $3`, [
      encryptText(stored),
      guestId,
      stored,
    ]);
  }
  return readStoredLinkToken(stored);
}

// TS-228: the guest's current RSVP link, read only -- null when they have none (or the guest isn't
// in this wedding). Unlike ensureGuestRsvpToken it never makes a link: "New link" reads the old one
// first, and for a guest who never had one that used to make a link only to replace it at once.
export async function readGuestRsvpToken(guestId: string, weddingId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT "rsvpToken" FROM "guests" WHERE id = $1 AND "weddingId" = $2`, [guestId, weddingId]);
  return readStoredLinkToken((rows[0]?.rsvpToken as string | null | undefined) ?? null);
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
export async function regenerateGuestRsvpToken(guestId: string, weddingId: string, actor?: ActorAccess): Promise<string | null> {
  // TS-204: with the person's access read again as the new link is made (see inWeddingChange).
  return inWeddingChange(weddingId, actor, async (q) => {
    const fresh = newLinkToken();
    const { rowCount } = await q.query(
    `UPDATE "guests" SET "rsvpToken" = $1, "rsvpTokenHash" = $2 WHERE id = $3 AND "weddingId" = $4`,
      [fresh.encrypted, fresh.hash, guestId, weddingId]
    );
    return (rowCount ?? 0) > 0 ? fresh.token : null;
  });
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
    await beginTransaction(client);
    // Which wedding to lock -- read without a lock, then checked again under it below.
    const { rows: found } = await client.query<{ weddingId: string }>(
      `SELECT "weddingId" FROM "guests" WHERE "rsvpTokenHash" = $1`,
      [tokenHash]
    );
    if (!found[0]) throw new RsvpSubmissionError("This RSVP link isn't valid.", "NOT_FOUND");
    const weddingId = found[0].weddingId;
    const { rows: weddingRows } = await client.query<{ rsvpCutoffDate: string | null }>(
      `SELECT "rsvpCutoffDate"::text AS "rsvpCutoffDate" FROM "weddings" WHERE id = $1 FOR NO KEY UPDATE`,
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
       FROM "guests" WHERE "rsvpTokenHash" = $1 AND "weddingId" = $2 FOR NO KEY UPDATE`,
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
      // TS-181: and the Restricted table they're on the list of, if any -- a guest's own answer is
      // never refused for growing their party past what that table holds for its list; the
      // re-check flags whoever no longer fits there, so the planner sees it.
      const { rows: seatedAt } = await client.query<{ tableId: string }>(
        `SELECT "seatingTableId" AS "tableId" FROM "seat_assignments" WHERE "planVersionId" = $1 AND "guestId" = $2
         UNION
         SELECT rtg."tableId" FROM "restricted_table_guests" rtg JOIN "seating_tables" t ON t.id = rtg."tableId"
         WHERE rtg."guestId" = $2 AND t."isRestricted"`,
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
