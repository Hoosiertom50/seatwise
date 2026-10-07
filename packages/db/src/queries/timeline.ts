import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { pool, beginTransaction } from "../pool";
import { inWeddingChange, recheckActorAccess, type ActorAccess } from "./wedding-lock";
import { assertWeddingHasRoom } from "./wedding-caps";

// TS-18 (FR-13.1/FR-13.2): a per-wedding, chronological run-of-show -- its own record, entirely
// independent of guests/tables/rules/seating plans. Always listed by (time, sortOrder): time is
// the plain "always chronological" ordering FR-13.1 asks for, and sortOrder only ever breaks ties
// between entries that share the exact same time (see reorderTimelineEntry below).

export interface TimelineEntryRow {
  id: string;
  weddingId: string;
  time: string;
  // TS-214: after midnight -- listed after the wedding day's own entries.
  nextDay: boolean;
  description: string;
  sortOrder: number;
  // TS-92: bumped on every edit and reorder.
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `id, "weddingId", time, "nextDay", description, "sortOrder", revision, "createdAt", "updatedAt"`;

// TS-174: the one order entries are shown and reordered in. Ties on sortOrder (left from before
// TS-153) are broken the same way in both, so "Up" always swaps with the entry shown just above --
// before, the list and the reorder could break a tie differently and swap the wrong pair.
// TS-214: next-day entries (after midnight) come after the wedding day's own -- the same order as
// compareTimelineEntries in @seatwise/shared, which the screens use.
export const TIMELINE_ENTRY_ORDER = `"nextDay" ASC, time ASC, "sortOrder" ASC, "createdAt" ASC, id ASC`;

// TS-174: the entry changed (its time moved, or it was removed) while it was being reordered --
// nothing was reordered; the caller shows the latest and the planner can try again.
export class TimelineReorderConflictError extends Error {
  constructor() {
    // TS-177: the screen doesn't reload the list on this answer, so it mustn't claim to.
    super("This timeline entry changed while it was being moved — nothing was reordered. Refresh the page to see the latest, then try again.");
  }
}

// TS-92: thrown instead of applying an edit whose expectedRevision no longer matches -- the fresh
// entry is attached so the caller can show the latest without another round-trip.
export class TimelineConflictError extends Error {
  entry: TimelineEntryRow;
  constructor(entry: TimelineEntryRow) {
    super("This timeline entry changed since you opened it (maybe in another tab, or by someone else) — showing the latest. Your edit wasn't saved; make it again if it's still needed.");
    this.entry = entry;
  }
}

export async function listTimelineEntriesForWedding(weddingId: string): Promise<TimelineEntryRow[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM "timeline_entries" WHERE "weddingId" = $1 ORDER BY ${TIMELINE_ENTRY_ORDER}`,
    [weddingId]
  );
  return rows;
}

export async function getTimelineEntryForWedding(id: string, weddingId: string): Promise<TimelineEntryRow | null> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM "timeline_entries" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return rows[0] ?? null;
}

export interface CreateTimelineEntryData {
  time: string;
  // TS-214: optional -- false (the wedding day) when not given.
  nextDay?: boolean;
  description: string;
}

// FR-13.1: a brand-new entry is appended after any existing entries that already share its exact
// time, rather than defaulting to 0 and landing arbitrarily among them.
// TS-204: in one transaction under the wedding's lock, with the person's access read again;
// TS-205: and refused past the wedding's cap on timeline entries (see wedding-caps.ts).
export async function createTimelineEntry(
  weddingId: string,
  input: CreateTimelineEntryData,
  actor?: ActorAccess
): Promise<TimelineEntryRow> {
  return inWeddingChange(
    weddingId,
    actor,
    async (client) => {
      await assertWeddingHasRoom(client, weddingId, "timelineEntries", 1);
      return insertTimelineEntry(client, weddingId, input);
    },
    { lockWedding: true }
  );
}

async function insertTimelineEntry(client: PoolClient, weddingId: string, input: CreateTimelineEntryData): Promise<TimelineEntryRow> {
  const id = randomUUID();
  const { rows: maxRows } = await client.query(
    `SELECT COALESCE(MAX("sortOrder"), -1) AS "maxSortOrder" FROM "timeline_entries" WHERE "weddingId" = $1 AND time = $2 AND "nextDay" = $3`,
    [weddingId, input.time, input.nextDay ?? false]
  );
  const sortOrder = maxRows[0].maxSortOrder + 1;

  const { rows } = await client.query(
    `INSERT INTO "timeline_entries" (id, "weddingId", time, "nextDay", description, "sortOrder", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING ${COLUMNS}`,
    [id, weddingId, input.time, input.nextDay ?? false, input.description, sortOrder]
  );
  return rows[0];
}

export async function updateTimelineEntry(
  id: string,
  weddingId: string,
  input: Partial<CreateTimelineEntryData>,
  expectedRevision?: number,
  /** TS-204: the access the edit was let in with -- read again first (TS-234). */
  actor?: ActorAccess
): Promise<TimelineEntryRow | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (input.time !== undefined) {
    fields.push(`time = $${i++}`);
    values.push(input.time);
  }
  if (input.nextDay !== undefined) {
    fields.push(`"nextDay" = $${i++}`);
    values.push(input.nextDay);
  }
  if (input.description !== undefined) {
    fields.push(`description = $${i++}`);
    values.push(input.description);
  }
  if (fields.length === 0) return getTimelineEntryForWedding(id, weddingId);

  fields.push(`"updatedAt" = now()`, `revision = revision + 1`);
  values.push(id, weddingId);
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-204: the person's access read again. TS-234: before the entry's lock, not after -- it
    // share-locks the wedding row, and taking that after the entry's lock was the other way round
    // from a wedding delete (wedding row, then its entries), so the two could deadlock and the edit
    // answered a server error. Now a delete running at that moment waits for this edit, or this
    // edit finds the wedding gone.
    if (actor) await recheckActorAccess(client, weddingId, actor);
    // TS-92: lock, then compare -- same pattern as guests/tables/vendors (FR-7.7).
    const { rows: current } = await client.query(
      // TS-187: NO KEY UPDATE -- the entry's id doesn't change here.
      `SELECT ${COLUMNS} FROM "timeline_entries" WHERE id = $1 AND "weddingId" = $2 FOR NO KEY UPDATE`,
      [id, weddingId]
    );
    if (!current[0]) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    if (expectedRevision !== undefined && current[0].revision !== expectedRevision) {
      await client.query("ROLLBACK").catch(() => {});
      throw new TimelineConflictError(current[0]);
    }
    // TS-153: moving an entry to a different time puts it last among that time's entries -- keeping
    // its old position number could tie with an entry already there, and tied entries could never
    // be reordered past each other.
    // TS-214: moving it to or from the next day is a move to a different time too.
    const newTime = input.time ?? current[0].time;
    const newNextDay = input.nextDay ?? current[0].nextDay;
    if (newTime !== current[0].time || newNextDay !== current[0].nextDay) {
      const { rows: maxRows } = await client.query(
        `SELECT COALESCE(MAX("sortOrder"), -1) AS "maxSortOrder" FROM "timeline_entries"
         WHERE "weddingId" = $1 AND time = $2 AND "nextDay" = $3 AND id <> $4`,
        [weddingId, newTime, newNextDay, id]
      );
      fields.splice(fields.length - 2, 0, `"sortOrder" = ${maxRows[0].maxSortOrder + 1}`);
    }
    const { rows } = await client.query(
      `UPDATE "timeline_entries" SET ${fields.join(", ")} WHERE id = $${i++} AND "weddingId" = $${i}
       RETURNING ${COLUMNS}`,
      values
    );
    await client.query("COMMIT");
    return rows[0] ?? null;
  } catch (err) {
    if (!(err instanceof TimelineConflictError)) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteTimelineEntry(id: string, weddingId: string, actor?: ActorAccess): Promise<boolean> {
  // TS-204: with the person's access read again as it's removed (see inWeddingChange).
  return inWeddingChange(weddingId, actor, async (client) => {
    const { rowCount } = await client.query(`DELETE FROM "timeline_entries" WHERE id = $1 AND "weddingId" = $2`, [id, weddingId]);
    return (rowCount ?? 0) > 0;
  });
}

// FR-13.2: "reordered" -- swaps this entry's sortOrder with whichever neighbor sharing its exact
// same `time` sits immediately UP (earlier) or DOWN (later) in that tied group. A no-op (returns
// the entry unchanged) if there's no such neighbor -- already first/last within its time group.
export async function reorderTimelineEntry(
  id: string,
  weddingId: string,
  direction: "UP" | "DOWN",
  /** TS-204: the access the request was let in with -- read again first (TS-234). */
  actor?: ActorAccess
): Promise<TimelineEntryRow | null> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-204: the person's access read again. TS-234: first, before the group's lock -- see
    // updateTimelineEntry (the other order could deadlock with a wedding delete).
    if (actor) await recheckActorAccess(client, weddingId, actor);
    const { rows: entryRows } = await client.query(
      `SELECT time, "nextDay" FROM "timeline_entries" WHERE id = $1 AND "weddingId" = $2`,
      [id, weddingId]
    );
    if (!entryRows[0]) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    // TS-153: lock the whole same-time group and work from its current order, so two reorders at
    // once can't both act on a stale picture; and renumber it 0..n-1 as it's saved, which also
    // repairs any ties left from before.
    const { rows: group } = await client.query<{ id: string; sortOrder: number }>(
      `SELECT id, "sortOrder" FROM "timeline_entries" WHERE "weddingId" = $1 AND time = $2 AND "nextDay" = $3
       ORDER BY ${TIMELINE_ENTRY_ORDER} FOR NO KEY UPDATE`,
      [weddingId, entryRows[0].time, entryRows[0].nextDay]
    );
    const index = group.findIndex((g) => g.id === id);
    // TS-174: its time was changed (or it was removed) between the two reads above -- before, this
    // fell through to a TypeError and a server error.
    if (index === -1) throw new TimelineReorderConflictError();
    const target = direction === "UP" ? index - 1 : index + 1;
    const swapped = new Set<string>();
    if (target >= 0 && target < group.length) {
      [group[index], group[target]] = [group[target], group[index]];
      swapped.add(group[index].id).add(group[target].id);
    }
    for (let position = 0; position < group.length; position++) {
      if (group[position].sortOrder !== position || swapped.has(group[position].id)) {
        // TS-92: a reorder bumps the moved entries' revisions, so an edit made from a copy loaded
        // before the reorder is caught too. TS-180: only the two entries that swapped places --
        // the others are just renumbered, which changes nothing anyone sees, so an edit someone
        // has open on one of them is no longer refused as "changed".
        const bump = swapped.has(group[position].id);
        await client.query(
          `UPDATE "timeline_entries" SET "sortOrder" = $1${bump ? `, "updatedAt" = now(), revision = revision + 1` : ""} WHERE id = $2`,
          [position, group[position].id]
        );
      }
    }
    // TS-220: the moved entry is read back inside the transaction, before COMMIT -- a read after
    // the commit could fail (500) or find nothing (404) after a reorder that was saved, and a second
    // click would then move it twice.
    const { rows: saved } = await client.query<TimelineEntryRow>(
      `SELECT ${COLUMNS} FROM "timeline_entries" WHERE id = $1 AND "weddingId" = $2`,
      [id, weddingId]
    );
    await client.query("COMMIT");
    return saved[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
