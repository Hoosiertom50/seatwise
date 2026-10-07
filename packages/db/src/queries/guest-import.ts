import { randomUUID } from "crypto";
import { pool, beginTransaction } from "../pool";
import { encryptText, decryptText } from "../crypto";
import { recheckActorAccess, WeddingDeletedError, type ActorAccess } from "./wedding-lock";
import { assertWeddingHasRoom } from "./wedding-caps";
import {
  lockCurrentPlan,
  lockRestrictedLists,
  recordRecheckIfApproved,
  resyncSeatsAtTable,
  restrictedListsOverCapacity,
  requiredAtNonAccessibleTable,
  tablesAffectedBy,
} from "./seat-checks";
import {
  parseCsv,
  CsvParseError,
  findDuplicateCsvHeader,
  duplicateCsvHeaderMessage,
  changedImportFields,
  importRowChangesNothing,
  parseGuestImportRow,
  spreadsheetRowNumber,
  withoutPlusOnesForPartyOfOne,
  type GuestImportKeptField,
  type GuestImportCurrentValues,
  type GuestImportMapping,
  type GuestImportRow,
  type GuestImportRowPreview,
  type GuestImportPreview,
  type GuestImportCommitResult,
} from "@seatwise/shared";

// FR-2.4/2.4a: bulk guest import. `classifyGuestImport` never writes anything -- it's the preview
// step, reused verbatim by `commitGuestImport` so the two can never classify a row differently.
export class GuestImportError extends Error {
  rows?: GuestImportRow[];
  constructor(message: string, rows?: GuestImportRow[]) {
    super(message);
    this.rows = rows;
  }
}

// TS-92: thrown by commitGuestImport when a guest the import would update was changed by someone
// else after the preview -- nothing is written, and the caller shows who changed so the planner can
// preview again against the latest.
export class GuestImportConflictError extends Error {
  guestNames: string[];
  // TS-180: "deleted" -- a guest in the file was deleted after the preview.
  constructor(guestNames: string[], what: "changed" | "deleted" = "changed") {
    const list = guestNames.length <= 3 ? guestNames.join(", ") : `${guestNames.slice(0, 3).join(", ")} and ${guestNames.length - 3} more`;
    const count = guestNames.length === 1 ? "a guest" : `${guestNames.length} guests`;
    super(
      what === "deleted"
        ? `Nothing was imported: ${count} in this file ${guestNames.length === 1 ? "was" : "were"} deleted since you previewed it (${list}). Preview again to see the latest, then import.`
        : `Nothing was imported: someone else changed ${count} in this file since you previewed it (${list}). Preview again to see the latest, then import.`
    );
    this.guestNames = guestNames;
  }
}

/** TS-209: the answer an earlier try of this import (same key) got, marked as a repeat -- or null. */
async function earlierImportResult(
  db: typeof pool | import("pg").PoolClient,
  weddingId: string,
  importKey: string
): Promise<GuestImportCommitResult | null> {
  const { rows } = await db.query<{ result: GuestImportCommitResult }>(
    `SELECT result FROM "guest_import_results" WHERE "weddingId" = $1 AND "importKey" = $2`,
    [weddingId, importKey]
  );
  return rows[0] ? { ...rows[0].result, repeated: true } : null;
}

/** TS-152: the most guests one import can add or update. */
export const MAX_IMPORT_ROWS = 5000;

export async function classifyGuestImport(
  weddingId: string,
  csv: string,
  mapping: GuestImportMapping
): Promise<GuestImportPreview> {
  return (await classifyRows(weddingId, csv, mapping)).preview;
}

// TS-190: also hands back the rows whose Guest ID isn't (or is no longer) in the wedding, so the
// commit can tell a guest deleted since the preview from a mistyped ID.
// TS-198: and, by row number, the text cells taken as they were because they said what the guest
// already had (see parseGuestImportRow) -- the commit checks they still do.
async function classifyRows(
  weddingId: string,
  csv: string,
  mapping: GuestImportMapping
): Promise<{
  preview: GuestImportPreview;
  unknownGuestIds: { guestId: string; name: string }[];
  keptAsIsByRow: Map<number, GuestImportKeptField[]>;
}> {
  if (!mapping.firstName || !mapping.lastName) {
    throw new GuestImportError('Map "First name" and "Last name" to a column before importing.');
  }
  // TS-198: a file holding the "couldn't read this character" mark (U+FFFD) is no longer refused as
  // a whole -- only a cell the import uses, and that says something new, is (see
  // parseGuestImportRow). A guest's own RSVP note in the export (never imported) used to block it.

  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(csv);
  } catch (err) {
    // TS-180: e.g. a quote that never closes -- say what's wrong rather than guess.
    if (err instanceof CsvParseError) throw new GuestImportError(err.message);
    throw err;
  }
  const { headers, rows: allRows } = parsed;
  // TS-180: two columns with the same name can't be told apart when mapping.
  const duplicateHeader = findDuplicateCsvHeader(headers);
  if (duplicateHeader !== null) throw new GuestImportError(duplicateCsvHeaderMessage(duplicateHeader));
  // TS-152: a completely blank row (a spacer someone left in the spreadsheet) is skipped, not an
  // error -- row numbers still match the spreadsheet. And one import is capped, so a huge file
  // can't tie up the database.
  const numbered = allRows
    .map((cells, index) => ({ cells, rowNumber: index + 1 }))
    .filter(({ cells }) => cells.some((c) => c.trim() !== ""));
  if (numbered.length > MAX_IMPORT_ROWS) {
    throw new GuestImportError(
      `That file has ${numbered.length.toLocaleString("en-US")} guests — import at most ${MAX_IMPORT_ROWS.toLocaleString("en-US")} at a time.`
    );
  }
  const rows = numbered.map((r) => r.cells);

  // TS-190: with each guest's current values, so a row that changes nothing shows as unchanged.
  const { rows: existingGuests } = await pool.query<
    { id: string; revision: number } & Omit<GuestImportCurrentValues, "notes"> & { notes: string | null }
  >(
    `SELECT id, revision, ${CURRENT_VALUE_COLUMNS} FROM "guests" WHERE "weddingId" = $1`,
    [weddingId]
  );
  const existingById = new Map(existingGuests.map((g) => [g.id, g]));
  const unknownGuestIds: { guestId: string; name: string }[] = [];
  const existingIds = new Set(existingGuests.map((g) => g.id));
  // TS-177: the wedding's own side names, so a "Side" column can use them. Read here, so the
  // preview and the commit (which re-runs this) always read a row the same way.
  const { rows: weddingRows } = await pool.query<{ sideLabel1: string; sideLabel2: string }>(
    `SELECT "sideLabel1", "sideLabel2" FROM "weddings" WHERE id = $1`,
    [weddingId]
  );
  const sideLabels = weddingRows[0] ?? { sideLabel1: "Bride", sideLabel2: "Groom" };
  const revisionById = new Map(existingGuests.map((g) => [g.id, g.revision]));

  // A guestId cell referenced by more than one row is ambiguous -- FR-2.4a calls this out as its
  // own row error, distinct from "not found".
  const guestIdCellCounts = new Map<string, number>();
  const guestIdColumnIndex = mapping.guestId ? headers.indexOf(mapping.guestId) : -1;
  if (guestIdColumnIndex !== -1) {
    for (const cells of rows) {
      const raw = (cells[guestIdColumnIndex] ?? "").trim();
      if (raw) guestIdCellCounts.set(raw, (guestIdCellCounts.get(raw) ?? 0) + 1);
    }
  }

  // TS-180: the "Version" column, when mapped -- the guest's revision when the file was exported.
  const versionColumnIndex = mapping.version ? headers.indexOf(mapping.version) : -1;

  const keptAsIsByRow = new Map<number, GuestImportKeptField[]>();
  // TS-222: a row's warnings (e.g. a Side name that disagrees with the Side code), shown in the preview.
  const warningByRow = new Map<number, string>();
  const classifiedRows: GuestImportRow[] = numbered.map(({ cells, rowNumber }) => {
    // TS-198: the guest this row updates (an ID used once, that is one of the wedding's guests),
    // so a cell that says what they already have isn't checked again -- see parseGuestImportRow.
    const idCell = guestIdColumnIndex === -1 ? "" : (cells[guestIdColumnIndex] ?? "").trim();
    const existingGuest =
      idCell && (guestIdCellCounts.get(idCell) ?? 0) === 1 ? existingById.get(idCell) : undefined;
    const { errors, warnings, data, keptAsIs } = parseGuestImportRow(
      cells,
      headers,
      mapping,
      sideLabels,
      existingGuest ? currentValuesOf(existingGuest) : undefined
    );
    if (keptAsIs.length > 0) keptAsIsByRow.set(rowNumber, keptAsIs);
    if (warnings.length > 0) warningByRow.set(rowNumber, warnings.join(" "));

    let exportedVersion: number | undefined;
    if (versionColumnIndex !== -1) {
      const raw = (cells[versionColumnIndex] ?? "").trim();
      if (raw) {
        const value = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
          errors.push(`Version "${raw}" isn't a whole number — leave the export's Version column as it was.`);
        } else {
          exportedVersion = value;
        }
      }
    }

    let guestId: string | undefined;
    if (guestIdColumnIndex !== -1) {
      const raw = (cells[guestIdColumnIndex] ?? "").trim();
      if (raw) {
        if ((guestIdCellCounts.get(raw) ?? 0) > 1) {
          errors.push(`Guest ID "${raw}" is referenced by more than one row in this file.`);
        } else if (!existingIds.has(raw)) {
          errors.push(`No guest with ID "${raw}" exists in this wedding.`);
          unknownGuestIds.push({
            guestId: raw,
            name: `${data.firstName ?? ""} ${data.lastName ?? ""}`.trim() || `row ${spreadsheetRowNumber(rowNumber)}`, // TS-225: as the spreadsheet numbers it
          });
        } else {
          guestId = raw;
        }
      }
    }

    if (errors.length > 0) {
      return { rowNumber, kind: "error", reason: errors.join("; "), guestId, preview: data };
    }
    if (guestId) {
      const revision = revisionById.get(guestId);
      // TS-190: a row the same as the guest already is changes nothing -- not even when the guest
      // was changed since the export (the file already says what they are now).
      const existing = existingById.get(guestId);
      if (existing && importRowChangesNothing(data, currentValuesOf(existing))) {
        return { rowNumber, kind: "unchanged", guestId, revision, preview: data };
      }
      // TS-180: the guest was changed in Seatwise after this file was exported -- writing the
      // file's (older) row would quietly undo that change.
      if (exportedVersion !== undefined && revision !== undefined && revision > exportedVersion) {
        return {
          rowNumber,
          kind: "conflict",
          guestId,
          revision,
          reason: "Changed in Seatwise since this file was exported — re-export, or tick to overwrite.",
          preview: data,
        };
      }
      return { rowNumber, kind: "update", guestId, revision, preview: data };
    }
    return { rowNumber, kind: "new", preview: data };
  });
  const classified = classifiedRows.map((r) => {
    const warning = warningByRow.get(r.rowNumber);
    return warning && r.kind !== "error" ? { ...r, warning } : r;
  });

  const preview: GuestImportPreview = {
    headers,
    rows: classified,
    summary: {
      newCount: classified.filter((r) => r.kind === "new").length,
      updatingCount: classified.filter((r) => r.kind === "update").length,
      unchangedCount: classified.filter((r) => r.kind === "unchanged").length,
      conflictCount: classified.filter((r) => r.kind === "conflict").length,
      errorCount: classified.filter((r) => r.kind === "error").length,
      totalRows: classified.length,
    },
  };
  return { preview, unknownGuestIds, keptAsIsByRow };
}

// TS-190: the guest columns an import row is compared with (see changedImportFields).
const CURRENT_VALUE_COLUMNS = `"firstName", "lastName", "partyName", headcount, tier, "rsvpStatus",
  "requiresAccessibleTable", "dayOfAttendance", side, "ageCategory", notes, "plusOneNames"`;

function currentValuesOf(g: Omit<GuestImportCurrentValues, "notes"> & { notes: string | null }): GuestImportCurrentValues {
  return {
    firstName: g.firstName,
    lastName: g.lastName,
    partyName: g.partyName,
    headcount: g.headcount,
    tier: g.tier,
    rsvpStatus: g.rsvpStatus,
    requiresAccessibleTable: g.requiresAccessibleTable,
    dayOfAttendance: g.dayOfAttendance,
    side: g.side,
    ageCategory: g.ageCategory,
    // Stored encrypted.
    notes: decryptText(g.notes),
    plusOneNames: g.plusOneNames,
  };
}

// FR-2.4: the confirmed import applies as one all-or-nothing operation -- re-classifies fresh
// (rather than trusting whatever the client last saw in its preview) and refuses to write
// anything at all if a single row still has an error.
export async function commitGuestImport(
  weddingId: string,
  csv: string,
  mapping: GuestImportMapping,
  expectedRevisions?: Record<string, number>,
  /** TS-169: who ran the import, for the plan's history. */
  actorUserId?: string,
  /** TS-180: also write rows for guests changed since the file was exported (the planner ticked to overwrite). */
  overwriteChanged = false,
  /** TS-195: the access the person was let in with -- read again under the wedding lock. */
  actorAccess?: ActorAccess,
  /** TS-209: the browser's key for this import -- the same key again gets the first answer back. */
  importKey?: string
): Promise<GuestImportCommitResult> {
  // TS-209: this import already went in (only its answer was lost) -- answer the same again rather
  // than importing it a second time. Checked again under the wedding lock below.
  if (importKey) {
    const earlier = await earlierImportResult(pool, weddingId, importKey);
    if (earlier) return earlier;
  }
  const { preview, unknownGuestIds, keptAsIsByRow } = await classifyRows(weddingId, csv, mapping);
  // TS-190: a guest the preview showed (so their ID is in expectedRevisions) but who is gone now
  // was deleted since the preview -- say so, rather than "No guest with ID ... exists".
  if (expectedRevisions) {
    const deleted = unknownGuestIds.filter((u) => expectedRevisions[u.guestId] !== undefined);
    if (deleted.length > 0) throw new GuestImportConflictError(deleted.map((u) => u.name), "deleted");
  }
  if (preview.summary.totalRows === 0) {
    throw new GuestImportError("The file has no data rows to import.");
  }
  if (preview.summary.errorCount > 0) {
    throw new GuestImportError(
      `${preview.summary.errorCount} row(s) still have errors -- fix them before importing (nothing was saved).`,
      preview.rows.filter((r) => r.kind === "error")
    );
  }

  // TS-180: a row for a guest changed in Seatwise since the file was exported is left alone unless
  // the planner chose to overwrite those guests.
  const rowsToWrite = preview.rows.filter((r) => r.kind !== "conflict" || overwriteChanged);
  const skippedCount = preview.rows.length - rowsToWrite.length;
  // TS-190: an "unchanged" row is locked and checked like an update -- whether it still changes
  // nothing is decided again below, under the lock.
  const isUpdateRow = (r: GuestImportRow) =>
    (r.kind === "update" || r.kind === "unchanged" || r.kind === "conflict") && !!r.guestId;

  const client = await pool.connect();
  try {
    // TS-180/TS-187: this transaction locks the whole wedding, so it's held to the app's time
    // limits (beginTransaction sets them for this transaction).
    await beginTransaction(client);
    // TS-173: the same wedding lock Generate, Restore and attendance changes take, then the
    // current plan's row (see lockCurrentPlan) -- and the current plan read under them. Before,
    // it was read before the transaction, so an import racing a Generate could leave guests it
    // marked Not Attending seated in the new version.
    const { rows: weddingLocked } = await client.query(`SELECT id FROM "weddings" WHERE id = $1 FOR NO KEY UPDATE`, [weddingId]);
    // TS-195: deleted meanwhile -- said as such; and the person's access read again under the lock
    // (removed or lowered while the import waited: nothing saved).
    if (!weddingLocked[0]) throw new WeddingDeletedError();
    if (actorAccess) await recheckActorAccess(client, weddingId, actorAccess);
    // TS-209: under the wedding lock, so two tries of one import can't both get past this.
    if (importKey) {
      const earlier = await earlierImportResult(client, weddingId, importKey);
      if (earlier) {
        await client.query("ROLLBACK");
        return earlier;
      }
    }
    const planVersionId: string | undefined = (await lockCurrentPlan(client, weddingId)) ?? undefined;
    // TS-187: then the Restricted tables' lists (a party that grows is checked against them below),
    // before any guest's row -- the same order a list save takes them in.
    await lockRestrictedLists(client, weddingId);

    // TS-92: refuse the whole import (it's all-or-nothing already) if any guest it would update
    // was changed by someone else after the planner previewed it -- otherwise the import would
    // silently overwrite that edit. Rows are locked so nothing can change between this check and
    // the writes below.
    const updateRows = rowsToWrite.filter(isUpdateRow);
    const updateIds = updateRows.map((r) => r.guestId!);
    // TS-174: and what each of them is now (read under the same lock), so a row only changes what
    // it actually changes -- see the party size and attendance rules below.
    const currentById = new Map<
      string,
      { revision: number; name: string; headcount: number; rsvpStatus: string; dayOfAttendance: string }
    >();
    const currentValuesById = new Map<string, GuestImportCurrentValues>();
    if (updateIds.length > 0) {
      const { rows: locked } = await client.query<{
        id: string;
        revision: number;
        name: string;
        headcount: number;
        rsvpStatus: string;
        dayOfAttendance: string;
      }>(
        `SELECT id, revision, ("firstName" || ' ' || "lastName") AS name, headcount, "rsvpStatus", "dayOfAttendance"
         FROM "guests" WHERE "weddingId" = $1 AND id = ANY($2::text[]) ORDER BY id FOR NO KEY UPDATE`,
        [weddingId, updateIds]
      );
      for (const g of locked) currentById.set(g.id, g);
      // TS-180: a guest in the file was deleted after the preview -- refuse, rather than count a
      // row that changed nothing as "updated".
      const deleted = updateRows.filter((r) => !currentById.has(r.guestId!));
      if (deleted.length > 0) {
        throw new GuestImportConflictError(
          deleted.map((r) => `${r.preview.firstName ?? ""} ${r.preview.lastName ?? ""}`.trim()),
          "deleted"
        );
      }
      // TS-190: every value of these guests as they are now (already locked above), so a row only
      // writes what it really changes.
      const { rows: values } = await client.query<
        { id: string } & Omit<GuestImportCurrentValues, "notes"> & { notes: string | null }
      >(`SELECT id, ${CURRENT_VALUE_COLUMNS} FROM "guests" WHERE "weddingId" = $1 AND id = ANY($2::text[])`, [
        weddingId,
        updateIds,
      ]);
      for (const g of values) currentValuesById.set(g.id, currentValuesOf(g));

      // TS-198: only the rows that still change their guest (as they are now, under the lock) are
      // checked against the versions the preview showed -- a guest whose row changes nothing (an
      // RSVP they sent between the preview and the import, say, that the file doesn't touch) used
      // to cancel the whole import.
      const changedNames: string[] = [];
      for (const row of updateRows) {
        const guest = currentById.get(row.guestId!)!;
        const now = currentValuesById.get(row.guestId!);
        const changes = now ? changedImportFields(row.preview, now) : row.preview;
        if (Object.keys(changes).length === 0) continue;
        const revisionMoved =
          expectedRevisions !== undefined &&
          expectedRevisions[row.guestId!] !== undefined &&
          expectedRevisions[row.guestId!] !== guest.revision;
        // TS-198: a cell taken as it was because it said what the guest had (see
        // parseGuestImportRow) that no longer does -- the guest changed since, and the file's value
        // was never checked, so it isn't written either.
        const keptChanged = (keptAsIsByRow.get(row.rowNumber) ?? []).some((field) => field in changes);
        if (revisionMoved || keptChanged) changedNames.push(guest.name);
      }
      if (changedNames.length > 0) throw new GuestImportConflictError(changedNames);
    }

    let createdCount = 0;
    let updatedCount = 0;
    // TS-190: rows that would leave their guest exactly as they are -- not written.
    let unchangedCount = 0;
    // FR-2.9: names of guests whose current assignment was flagged Needs Reassignment by this
    // import, surfaced to the caller the same way TS-7's table-side re-check surfaces warnings.
    const reassignmentWarnings: string[] = [];
    // TS-150: seated guests whose table needs re-checking once every row is written.
    const recheckGuestIds = new Set<string>();
    // TS-165: tables left by guests marked Not Attending in this import.
    const recheckTableIds = new Set<string>();
    let planFlagsChanged = false;
    // TS-169: whether any seat was freed or any attending guest added (for history and revision).
    let seatsFreed = false;
    let attendingAdded = false;
    // TS-174: a Declined guest brought back to Attending by this import -- the plan has someone new
    // to seat, as when the planner does it by hand (which bumps the plan's revision too).
    let attendanceRestored = false;
    // TS-181: updated guests whose party this import makes bigger.
    // TS-198: and guests it brings back to Attending -- they need their seats on a Restricted
    // table's list again (see below).
    const grownGuestIds = new Set<string>();
    const returningGuestIds = new Set<string>();
    // TS-180: guests this import marks Not Attending -- their seats are freed together below.
    const freedGuestIds: string[] = [];
    // TS-180: rows are written in two statements (one for new guests, one for updates) rather than
    // one per row, so a big file doesn't hold the wedding's lock for long.
    const inserts: GuestImportRowPreview[] = [];
    const updates: { guestId: string; p: GuestImportRowPreview }[] = [];

    for (const row of rowsToWrite) {
      let p = row.preview;
      // TS-169: a row that makes a guest Declined (and doesn't set attendance itself) marks them Not
      // Attending -- the same rule as everywhere else a guest declines (TS-167). For an existing
      // guest, only when this changes their answer.
      const current = isUpdateRow(row) ? currentById.get(row.guestId!) : undefined;
      // TS-190: an export always carries Attendance, mostly unchanged -- and an unchanged value
      // isn't the planner setting it, so it mustn't stop the rules below (as for the party size).
      // Before, changing only the RSVP in an exported file never freed (or gave back) the seat.
      if (current && p.dayOfAttendance !== undefined && p.dayOfAttendance === current.dayOfAttendance) {
        p = { ...p, dayOfAttendance: undefined };
      }
      if (p.rsvpStatus === "DECLINED" && p.dayOfAttendance === undefined) {
        const changes = current ? current.rsvpStatus !== "DECLINED" : true;
        if (changes) p = { ...p, dayOfAttendance: "NOT_ATTENDING" };
      }
      // TS-174: and the other way round, as editing the guest does (TS-169): a Declined guest the
      // import sets to Confirmed or Pending (and doesn't set attendance for) is Attending again,
      // waiting unseated for the planner. Before, they stayed Not Attending.
      if (
        current &&
        p.rsvpStatus !== undefined &&
        p.rsvpStatus !== "DECLINED" &&
        current.rsvpStatus === "DECLINED" &&
        p.dayOfAttendance === undefined
      ) {
        p = { ...p, dayOfAttendance: "ATTENDING" };
      }
      // TS-174: re-importing an export carries everyone's party size, mostly unchanged -- and an
      // unchanged party size isn't the planner setting a new one, so it must not wipe the limit a
      // guest's RSVP is held to (TS-154). Only a real change counts.
      if (current && p.headcount !== undefined && p.headcount === current.headcount) {
        p = { ...p, headcount: undefined };
      }
      // TS-190: and only what really changes is written (see changedImportFields).
      const currentValues = isUpdateRow(row) ? currentValuesById.get(row.guestId!) : undefined;
      if (currentValues) p = changedImportFields(p, currentValues);
      // TS-202: checked again against the guest as they are now (under the lock) -- a party of one
      // keeps no plus-ones.
      p = withoutPlusOnesForPartyOfOne(p, currentValues);
      if (row.kind === "new") {
        inserts.push(p);
        createdCount++;
        if ((p.dayOfAttendance ?? "ATTENDING") === "ATTENDING") attendingAdded = true;
      } else if (isUpdateRow(row)) {
        const guestId = row.guestId!;
        const changesSomething =
          p.firstName !== undefined ||
          p.lastName !== undefined ||
          "partyName" in p ||
          p.headcount !== undefined ||
          p.tier !== undefined ||
          p.rsvpStatus !== undefined ||
          p.requiresAccessibleTable !== undefined ||
          p.dayOfAttendance !== undefined ||
          p.side !== undefined ||
          p.ageCategory !== undefined ||
          "notes" in p ||
          "plusOneNames" in p;
        // TS-190: a row that changes nothing is left alone -- not written, not counted as updated,
        // and the guest's revision isn't bumped.
        if (!changesSomething) {
          unchangedCount++;
          continue;
        }
        updates.push({ guestId, p });
        // TS-181: checked against their Restricted table's list (if any) once every row is in.
        if (p.headcount !== undefined && (!current || p.headcount > current.headcount)) grownGuestIds.add(guestId);
        updatedCount++;
        // TS-174: brought back to Attending -- counts like a new attending guest (history, and the
        // plan's revision).
        if (p.dayOfAttendance === "ATTENDING" && current?.dayOfAttendance === "NOT_ATTENDING") {
          attendingAdded = true;
          attendanceRestored = true;
          returningGuestIds.add(guestId);
        }

        // FR-2.9: Attendance Status -> Not Attending frees the seat outright (matching FR-8.1's
        // dedicated day-of behavior, not just a flag) regardless of anything else in this row;
        // otherwise, if any of the other named trigger fields changed, re-check this guest's
        // current assignment (if they have one) against hard rules.
        if (p.dayOfAttendance === "NOT_ATTENDING") {
          freedGuestIds.push(guestId);
        } else if (
          planVersionId &&
          (p.side !== undefined ||
            p.tier !== undefined ||
            "partyName" in p ||
            p.requiresAccessibleTable !== undefined ||
            // TS-150: a bigger party can push their table over capacity.
            p.headcount !== undefined)
        ) {
          recheckGuestIds.add(guestId);
        }
      }
    }

    if (inserts.length > 0) {
      // TS-205: the wedding's guest cap, counted under the wedding's lock held since the start.
      await assertWeddingHasRoom(client, weddingId, "guests", inserts.length);
      await client.query(
        `INSERT INTO "guests"
           (id, "weddingId", "firstName", "lastName", "partyName", headcount, tier, "rsvpStatus",
            "requiresAccessibleTable", "dayOfAttendance", notes, side, "ageCategory", "plusOneNames", "updatedAt")
         SELECT x.id, $1, x."firstName", x."lastName", x."partyName", x.headcount, x.tier, x."rsvpStatus",
                x."requiresAccessibleTable", x."dayOfAttendance", x.notes, x.side, x."ageCategory", x."plusOneNames", now()
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::"GuestTier"[], $8::"RsvpStatus"[],
                     $9::boolean[], $10::"DayOfAttendance"[], $11::text[], $12::"GuestSide"[], $13::"AgeCategory"[], $14::text[])
           AS x(id, "firstName", "lastName", "partyName", headcount, tier, "rsvpStatus",
                "requiresAccessibleTable", "dayOfAttendance", notes, side, "ageCategory", "plusOneNames")`,
        [
          weddingId,
          inserts.map(() => randomUUID()),
          inserts.map((p) => p.firstName),
          inserts.map((p) => p.lastName),
          inserts.map((p) => p.partyName ?? null),
          inserts.map((p) => p.headcount ?? 1),
          inserts.map((p) => p.tier ?? "OTHER"),
          inserts.map((p) => p.rsvpStatus ?? "PENDING"),
          inserts.map((p) => p.requiresAccessibleTable ?? false),
          inserts.map((p) => p.dayOfAttendance ?? "ATTENDING"),
          inserts.map((p) => encryptText(p.notes ?? null)),
          inserts.map((p) => p.side ?? "BOTH"),
          inserts.map((p) => p.ageCategory ?? "ADULT"),
          inserts.map((p) => p.plusOneNames ?? null),
        ]
      );
    }

    if (updates.length > 0) {
      // A null value leaves that field as it is; the three fields that can be cleared (household,
      // notes, plus-ones) carry a separate "set" flag so a CLEAR still clears them. TS-154: a new
      // party size is the guest's new limit. TS-92: revision is bumped like every other guest edit,
      // so anyone holding this guest from before the import gets a conflict on their next save.
      await client.query(
        `UPDATE "guests" g SET
           "firstName" = COALESCE(x."firstName", g."firstName"),
           "lastName" = COALESCE(x."lastName", g."lastName"),
           "partyName" = CASE WHEN x."setPartyName" THEN x."partyName" ELSE g."partyName" END,
           headcount = COALESCE(x.headcount, g.headcount),
           "partySizeLimit" = CASE WHEN x.headcount IS NULL THEN g."partySizeLimit" ELSE NULL END,
           tier = COALESCE(x.tier, g.tier),
           "rsvpStatus" = COALESCE(x."rsvpStatus", g."rsvpStatus"),
           "requiresAccessibleTable" = COALESCE(x."requiresAccessibleTable", g."requiresAccessibleTable"),
           "dayOfAttendance" = COALESCE(x."dayOfAttendance", g."dayOfAttendance"),
           side = COALESCE(x.side, g.side),
           "ageCategory" = COALESCE(x."ageCategory", g."ageCategory"),
           notes = CASE WHEN x."setNotes" THEN x.notes ELSE g.notes END,
           "plusOneNames" = CASE WHEN x."setPlusOneNames" THEN x."plusOneNames" ELSE g."plusOneNames" END,
           "updatedAt" = now(),
           revision = g.revision + 1
         FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[], $7::int[], $8::"GuestTier"[],
                     $9::"RsvpStatus"[], $10::boolean[], $11::"DayOfAttendance"[], $12::"GuestSide"[], $13::"AgeCategory"[],
                     $14::boolean[], $15::text[], $16::boolean[], $17::text[])
           AS x(id, "firstName", "lastName", "setPartyName", "partyName", headcount, tier,
                "rsvpStatus", "requiresAccessibleTable", "dayOfAttendance", side, "ageCategory",
                "setNotes", notes, "setPlusOneNames", "plusOneNames")
         WHERE g.id = x.id AND g."weddingId" = $1`,
        [
          weddingId,
          updates.map((u) => u.guestId),
          updates.map((u) => u.p.firstName ?? null),
          updates.map((u) => u.p.lastName ?? null),
          updates.map((u) => "partyName" in u.p),
          updates.map((u) => u.p.partyName ?? null),
          updates.map((u) => u.p.headcount ?? null),
          updates.map((u) => u.p.tier ?? null),
          updates.map((u) => u.p.rsvpStatus ?? null),
          updates.map((u) => u.p.requiresAccessibleTable ?? null),
          updates.map((u) => u.p.dayOfAttendance ?? null),
          updates.map((u) => u.p.side ?? null),
          updates.map((u) => u.p.ageCategory ?? null),
          updates.map((u) => "notes" in u.p),
          updates.map((u) => ("notes" in u.p ? encryptText(u.p.notes ?? null) : null)),
          updates.map((u) => "plusOneNames" in u.p),
          updates.map((u) => u.p.plusOneNames ?? null),
        ]
      );
    }

    // FR-2.9 / TS-165: free the seats of everyone this import marked Not Attending, after noting
    // the tables they leave (and their rule partners' tables) for the re-check below.
    if (planVersionId && freedGuestIds.length > 0) {
      for (const t of await tablesAffectedBy(client, weddingId, planVersionId, freedGuestIds)) recheckTableIds.add(t);
      const { rowCount: freed } = await client.query(
        `DELETE FROM "seat_assignments" WHERE "planVersionId" = $1 AND "guestId" = ANY($2::text[])`,
        [planVersionId, freedGuestIds]
      );
      if (freed) seatsFreed = true;
    }


    // TS-181: a bigger party for a guest on a Restricted table's required-guest list must still let
    // the list fit that table -- otherwise nothing is imported, as when the planner edits the guest.
    // TS-198: the same for a guest the file brings back to Attending (its Attendance cell, or a
    // Declined guest set back to Confirmed or Pending) -- as when the planner marks them Attending
    // again (TS-188). Before, the file could fill a Restricted table's list past its seats.
    const [listOver] = await restrictedListsOverCapacity(client, [...new Set([...grownGuestIds, ...returningGuestIds])]);
    if (listOver) {
      const what = [...returningGuestIds].some((id) => !grownGuestIds.has(id))
        ? "the party sizes and attendance in this file"
        : "the party sizes in this file";
      throw new GuestImportError(
        `Nothing was imported: ${listOver.guestNames.join(", ") || "a guest"} ${listOver.guestNames.length === 1 ? "is" : "are"} on "${listOver.tableLabel}"'s required-guest list, and ${what} would need ${listOver.seats} seats there — it has ${listOver.capacity}. Give that table more seats, or take them off its list first.`
      );
    }
    // TS-188: nor can the file mark a listed guest as needing an accessible table when their
    // Restricted table isn't accessible -- refused the same way.
    const [notAccessible] = await requiredAtNonAccessibleTable(
      client,
      updates.filter((u) => u.p.requiresAccessibleTable === true).map((u) => u.guestId)
    );
    if (notAccessible) {
      throw new GuestImportError(
        `Nothing was imported: ${notAccessible.guestName} is on "${notAccessible.tableLabel}"'s required-guest list, and this file marks them as needing an accessible table — "${notAccessible.tableLabel}" isn't marked Accessible. Mark it Accessible first, or take them off its list.`
      );
    }

    // TS-150: re-check every table an updated guest sits at -- rules *and* room -- inside this
    // same transaction, so a capacity flag is never cleared by mistake and a bigger party is caught.
    if (planVersionId && (recheckGuestIds.size > 0 || recheckTableIds.size > 0)) {
      const { rows: tableRows } = await client.query(
        `SELECT DISTINCT "seatingTableId" AS "tableId" FROM "seat_assignments"
         WHERE "planVersionId" = $1 AND "guestId" = ANY($2::text[]) ORDER BY 1`,
        [planVersionId, [...recheckGuestIds]]
      );
      const tableIds = [...new Set([...(tableRows as { tableId: string }[]).map((r) => r.tableId), ...recheckTableIds])].sort();
      for (const tableId of tableIds) {
        const { newlyFlagged, changed } = await resyncSeatsAtTable(client, weddingId, planVersionId, tableId);
        if (changed) planFlagsChanged = true;
        for (const f of newlyFlagged) {
          reassignmentWarnings.push(
            f.reason === "capacity"
              ? `${f.name} no longer fits at their table — flagged as Needs Reassignment.`
              : `${f.name}'s current table no longer fits a hard rule for them — flagged as Needs Reassignment.`
          );
        }
      }
    }

    if (planVersionId) {
      const { rows: countRows } = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM "guests" g WHERE g."weddingId" = $1 AND g."dayOfAttendance" = 'ATTENDING'
              AND NOT EXISTS (SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $2 AND sa."guestId" = g.id)
           ) AS "unassignedCount",
           (SELECT COUNT(*)::int FROM "seat_assignments" WHERE "planVersionId" = $2 AND "needsReassignment" = true)
             AS "needsReassignmentCount"`,
        [weddingId, planVersionId]
      );
      const isComplete =
        countRows[0].unassignedCount === 0 && countRows[0].needsReassignmentCount === 0;
      // TS-150: a change to who's flagged also bumps the plan's revision. TS-169: so does a freed seat.
      // TS-174: and a guest brought back to Attending.
      await client.query(
        `UPDATE "plan_versions" SET "isComplete" = $1${planFlagsChanged || seatsFreed || attendanceRestored || attendingAdded ? ", revision = revision + 1" : ""} WHERE id = $2`,
        [isComplete, planVersionId]
      );
      // TS-169: an import that changes an approved plan (a seat freed, someone new to seat, flags
      // changed) shows on it as "Modified since approval", like any other change.
      if (planFlagsChanged || seatsFreed || attendingAdded) {
        await recordRecheckIfApproved(
          client,
          planVersionId,
          `Guest import: ${createdCount} added, ${updatedCount} updated — seating re-checked`,
          actorUserId ?? null
        );
      }
    }

    const result: GuestImportCommitResult = { createdCount, updatedCount, skippedCount, unchangedCount, warnings: reassignmentWarnings };
    // TS-209: kept with the import itself (same transaction), for a repeat of it -- and the wedding's
    // answers from more than a day ago are cleared.
    if (importKey) {
      await client.query(
        `DELETE FROM "guest_import_results" WHERE "weddingId" = $1 AND "createdAt" < now() - interval '1 day'`,
        [weddingId]
      );
      await client.query(
        `INSERT INTO "guest_import_results" ("weddingId", "importKey", result) VALUES ($1, $2, $3::jsonb)`,
        [weddingId, importKey, JSON.stringify(result)]
      );
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
