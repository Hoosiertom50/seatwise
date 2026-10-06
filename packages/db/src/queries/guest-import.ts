import { randomUUID } from "crypto";
import { pool, STATEMENT_TIMEOUT_MS, IDLE_IN_TRANSACTION_TIMEOUT_MS } from "../pool";
import { encryptText } from "../crypto";
import {
  lockCurrentPlan,
  recordRecheckIfApproved,
  resyncSeatsAtTable,
  restrictedListsOverCapacity,
  requiredAtNonAccessibleTable,
  tablesAffectedBy,
} from "./seat-checks";
import {
  parseCsv,
  guestTierEnum,
  rsvpStatusEnum,
  dayOfAttendanceEnum,
  parseGuestSide,
  ageCategoryEnum,
  PERSON_NAME_PATTERN,
  PERSON_NAME_MESSAGE,
  looksLikeWebAddress,
  NO_WEB_ADDRESS_MESSAGE,
  hasMixedScriptWord,
  NO_MIXED_SCRIPT_MESSAGE,
  hasForbiddenControlCharacter,
  CONTROL_CHARACTER_MESSAGE,
  CsvParseError,
  findDuplicateCsvHeader,
  duplicateCsvHeaderMessage,
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

// A field that's nullable on the guest record (partyName, notes) needs a way to say "clear this
// value" that's distinct from "this cell is blank, leave the existing value alone" (FR-2.4a) --
// this literal token is that signal.
// TS-180: "[CLEAR]" (any case) is the documented token now. Plain CLEAR still works, but only in
// capitals -- a household really called "Clear" used to be wiped instead of saved.
function isClearToken(value: string): boolean {
  return value === "CLEAR" || value.toUpperCase() === "[CLEAR]";
}

// TS-180: the same hidden-character rule as the app's forms (see safeText), for free-text cells.
function checkFreeText(label: string, value: string, max: number, errors: string[]): boolean {
  if (value.length > max) {
    errors.push(`${label} can be at most ${max} characters.`);
    return false;
  }
  if (hasForbiddenControlCharacter(value)) {
    errors.push(`${label}: ${CONTROL_CHARACTER_MESSAGE.toLowerCase()}.`);
    return false;
  }
  return true;
}

function normalizeEnumValue(raw: string, allowed: readonly string[]): string | null {
  const normalized = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return allowed.includes(normalized) ? normalized : null;
}

function parseRow(
  cells: string[],
  headers: string[],
  mapping: GuestImportMapping,
  sideLabels: { sideLabel1: string; sideLabel2: string }
): { errors: string[]; data: GuestImportRowPreview } {
  const errors: string[] = [];
  const data: GuestImportRowPreview = {};

  function cellFor(field: keyof GuestImportMapping): string | undefined {
    const header = mapping[field];
    if (!header) return undefined;
    const idx = headers.indexOf(header);
    if (idx === -1) return undefined;
    const value = cells[idx];
    return value === undefined ? undefined : value.trim();
  }

  const firstName = cellFor("firstName");
  const lastName = cellFor("lastName");
  if (!firstName || !lastName) {
    errors.push("Missing required name (first and last name are both required).");
  } else {
    // Same 100-char cap and character allowlist as the single-guest add/edit form (createGuestSchema)
    // -- this bulk path used to skip both, so a CSV could smuggle in a name the regular form would
    // have rejected outright.
    if (firstName.length > 100) {
      errors.push(`First name "${firstName}" is too long (100 characters max).`);
    } else if (!PERSON_NAME_PATTERN.test(firstName)) {
      errors.push(`First name "${firstName}" is invalid: ${PERSON_NAME_MESSAGE.toLowerCase()}.`);
    } else if (looksLikeWebAddress(firstName)) {
      // TS-168: same rule as adding a guest by hand (names go into emails).
      errors.push(`First name "${firstName}" is invalid: ${NO_WEB_ADDRESS_MESSAGE.toLowerCase()}.`);
    } else if (hasMixedScriptWord(firstName)) {
      // TS-178: same rule as adding a guest by hand.
      errors.push(`First name "${firstName}" is invalid: ${NO_MIXED_SCRIPT_MESSAGE.toLowerCase()}.`);
    } else {
      data.firstName = firstName;
    }
    if (lastName.length > 100) {
      errors.push(`Last name "${lastName}" is too long (100 characters max).`);
    } else if (!PERSON_NAME_PATTERN.test(lastName)) {
      errors.push(`Last name "${lastName}" is invalid: ${PERSON_NAME_MESSAGE.toLowerCase()}.`);
    } else if (looksLikeWebAddress(lastName)) {
      errors.push(`Last name "${lastName}" is invalid: ${NO_WEB_ADDRESS_MESSAGE.toLowerCase()}.`);
    } else if (hasMixedScriptWord(lastName)) {
      errors.push(`Last name "${lastName}" is invalid: ${NO_MIXED_SCRIPT_MESSAGE.toLowerCase()}.`);
    } else {
      data.lastName = lastName;
    }
  }

  const partyName = cellFor("partyName");
  if (partyName !== undefined && partyName !== "") {
    // TS-152: the same limit as adding a guest by hand.
    if (isClearToken(partyName)) data.partyName = null;
    else if (checkFreeText("Household name", partyName, 200, errors)) data.partyName = partyName;
  }

  const headcountRaw = cellFor("headcount");
  if (headcountRaw !== undefined && headcountRaw !== "") {
    const value = Number(headcountRaw);
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      errors.push(`Headcount must be a whole number between 1 and 20 (got "${headcountRaw}").`);
    } else {
      data.headcount = value;
    }
  }

  const tierRaw = cellFor("tier");
  if (tierRaw !== undefined && tierRaw !== "") {
    const normalized = normalizeEnumValue(tierRaw, guestTierEnum.options);
    if (!normalized) {
      errors.push(`Tier "${tierRaw}" isn't one of ${guestTierEnum.options.join(", ")}.`);
    } else {
      data.tier = normalized;
    }
  }

  const rsvpRaw = cellFor("rsvpStatus");
  if (rsvpRaw !== undefined && rsvpRaw !== "") {
    const normalized = normalizeEnumValue(rsvpRaw, rsvpStatusEnum.options);
    if (!normalized) {
      errors.push(`RSVP status "${rsvpRaw}" isn't one of ${rsvpStatusEnum.options.join(", ")}.`);
    } else {
      data.rsvpStatus = normalized;
    }
  }

  const accessibleRaw = cellFor("requiresAccessibleTable");
  if (accessibleRaw !== undefined && accessibleRaw !== "") {
    const normalized = accessibleRaw.toLowerCase();
    if (["yes", "y", "true", "1"].includes(normalized)) data.requiresAccessibleTable = true;
    else if (["no", "n", "false", "0"].includes(normalized)) data.requiresAccessibleTable = false;
    else errors.push(`"Requires accessible table" must be yes/no (got "${accessibleRaw}").`);
  }

  const dayOfRaw = cellFor("dayOfAttendance");
  if (dayOfRaw !== undefined && dayOfRaw !== "") {
    const normalized = normalizeEnumValue(dayOfRaw, dayOfAttendanceEnum.options);
    if (!normalized) {
      errors.push(`Attendance "${dayOfRaw}" isn't one of ${dayOfAttendanceEnum.options.join(", ")}.`);
    } else {
      data.dayOfAttendance = normalized;
    }
  }

  // TS-177: the wedding's own side names (what the Guests tab tells planners to use) as well as
  // "Both" and the stored BRIDE / GROOM -- see parseGuestSide.
  const sideRaw = cellFor("side");
  if (sideRaw !== undefined && sideRaw !== "") {
    const side = parseGuestSide(sideRaw, sideLabels.sideLabel1, sideLabels.sideLabel2);
    if ("error" in side) errors.push(side.error);
    else data.side = side.side;
  }

  const ageCategoryRaw = cellFor("ageCategory");
  if (ageCategoryRaw !== undefined && ageCategoryRaw !== "") {
    const normalized = normalizeEnumValue(ageCategoryRaw, ageCategoryEnum.options);
    if (!normalized) {
      errors.push(`Age category "${ageCategoryRaw}" isn't one of ${ageCategoryEnum.options.join(", ")}.`);
    } else {
      data.ageCategory = normalized;
    }
  }

  const notes = cellFor("notes");
  if (notes !== undefined && notes !== "") {
    if (isClearToken(notes)) data.notes = null;
    else if (checkFreeText("Notes", notes, 2000, errors)) data.notes = notes.replace(/\r\n/g, "\n");
  }

  // TS-180: the export's "Plus-ones" column -- who's coming with the guest.
  const plusOneNames = cellFor("plusOneNames");
  if (plusOneNames !== undefined && plusOneNames !== "") {
    if (isClearToken(plusOneNames)) data.plusOneNames = null;
    else if (checkFreeText("Plus-ones", plusOneNames, 500, errors)) data.plusOneNames = plusOneNames.replace(/\r\n/g, "\n");
  }

  return { errors, data };
}

/** TS-152: the most guests one import can add or update. */
export const MAX_IMPORT_ROWS = 5000;

export async function classifyGuestImport(
  weddingId: string,
  csv: string,
  mapping: GuestImportMapping
): Promise<GuestImportPreview> {
  if (!mapping.firstName || !mapping.lastName) {
    throw new GuestImportError('Map "First name" and "Last name" to a column before importing.');
  }

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

  const { rows: existingGuests } = await pool.query<{ id: string; revision: number }>(
    `SELECT id, revision FROM "guests" WHERE "weddingId" = $1`,
    [weddingId]
  );
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

  const classified: GuestImportRow[] = numbered.map(({ cells, rowNumber }) => {
    const { errors, data } = parseRow(cells, headers, mapping, sideLabels);

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

  return {
    headers,
    rows: classified,
    summary: {
      newCount: classified.filter((r) => r.kind === "new").length,
      updatingCount: classified.filter((r) => r.kind === "update").length,
      conflictCount: classified.filter((r) => r.kind === "conflict").length,
      errorCount: classified.filter((r) => r.kind === "error").length,
      totalRows: classified.length,
    },
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
  overwriteChanged = false
): Promise<GuestImportCommitResult> {
  const preview = await classifyGuestImport(weddingId, csv, mapping);
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
  const isUpdateRow = (r: GuestImportRow) => (r.kind === "update" || r.kind === "conflict") && !!r.guestId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // TS-180: this transaction locks the whole wedding, so it's held to the same limits as the
    // pool's (set here too, as the pooled connection may not keep session settings).
    await client.query(
      `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}; SET LOCAL idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS}`
    );
    // TS-173: the same wedding lock Generate, Restore and attendance changes take, then the
    // current plan's row (see lockCurrentPlan) -- and the current plan read under them. Before,
    // it was read before the transaction, so an import racing a Generate could leave guests it
    // marked Not Attending seated in the new version.
    await client.query(`SELECT id FROM "weddings" WHERE id = $1 FOR NO KEY UPDATE`, [weddingId]);
    const planVersionId: string | undefined = (await lockCurrentPlan(client, weddingId)) ?? undefined;

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
         FROM "guests" WHERE "weddingId" = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE`,
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
      if (expectedRevisions) {
        const changed = locked.filter((g) => expectedRevisions[g.id] !== undefined && expectedRevisions[g.id] !== g.revision);
        if (changed.length > 0) {
          throw new GuestImportConflictError(changed.map((g) => g.name));
        }
      }
    }

    let createdCount = 0;
    let updatedCount = 0;
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
    const grownGuestIds = new Set<string>();
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
        if (changesSomething) updates.push({ guestId, p });
        // TS-181: checked against their Restricted table's list (if any) once every row is in.
        if (p.headcount !== undefined && (!current || p.headcount > current.headcount)) grownGuestIds.add(guestId);
        updatedCount++;
        // TS-174: brought back to Attending -- counts like a new attending guest (history, and the
        // plan's revision).
        if (p.dayOfAttendance === "ATTENDING" && current?.dayOfAttendance === "NOT_ATTENDING") {
          attendingAdded = true;
          attendanceRestored = true;
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
    const [listOver] = await restrictedListsOverCapacity(client, [...grownGuestIds]);
    if (listOver) {
      throw new GuestImportError(
        `Nothing was imported: ${listOver.guestNames.join(", ") || "a guest"} ${listOver.guestNames.length === 1 ? "is" : "are"} on "${listOver.tableLabel}"'s required-guest list, and the party sizes in this file would need ${listOver.seats} seats there — it has ${listOver.capacity}. Give that table more seats, or take them off its list first.`
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
        `UPDATE "plan_versions" SET "isComplete" = $1${planFlagsChanged || seatsFreed || attendanceRestored ? ", revision = revision + 1" : ""} WHERE id = $2`,
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

    await client.query("COMMIT");
    return { createdCount, updatedCount, skippedCount, warnings: reassignmentWarnings };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
