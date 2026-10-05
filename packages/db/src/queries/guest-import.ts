import { randomUUID } from "crypto";
import { pool } from "../pool";
import { encryptText } from "../crypto";
import { recordRecheckIfApproved, resyncSeatsAtTable, tablesAffectedBy } from "./seat-checks";
import {
  parseCsv,
  guestTierEnum,
  rsvpStatusEnum,
  dayOfAttendanceEnum,
  guestSideEnum,
  ageCategoryEnum,
  PERSON_NAME_PATTERN,
  PERSON_NAME_MESSAGE,
  looksLikeWebAddress,
  NO_WEB_ADDRESS_MESSAGE,
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
  constructor(guestNames: string[]) {
    const list = guestNames.length <= 3 ? guestNames.join(", ") : `${guestNames.slice(0, 3).join(", ")} and ${guestNames.length - 3} more`;
    super(
      `Nothing was imported: someone else changed ${guestNames.length === 1 ? "a guest" : `${guestNames.length} guests`} in this file since you previewed it (${list}). Preview again to see the latest, then import.`
    );
    this.guestNames = guestNames;
  }
}

// A field that's nullable on the guest record (partyName, notes) needs a way to say "clear this
// value" that's distinct from "this cell is blank, leave the existing value alone" (FR-2.4a) --
// this literal token (case-insensitive) is that signal.
const CLEAR_TOKEN = "CLEAR";

function normalizeEnumValue(raw: string, allowed: readonly string[]): string | null {
  const normalized = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return allowed.includes(normalized) ? normalized : null;
}

function parseRow(
  cells: string[],
  headers: string[],
  mapping: GuestImportMapping
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
    } else {
      data.firstName = firstName;
    }
    if (lastName.length > 100) {
      errors.push(`Last name "${lastName}" is too long (100 characters max).`);
    } else if (!PERSON_NAME_PATTERN.test(lastName)) {
      errors.push(`Last name "${lastName}" is invalid: ${PERSON_NAME_MESSAGE.toLowerCase()}.`);
    } else if (looksLikeWebAddress(lastName)) {
      errors.push(`Last name "${lastName}" is invalid: ${NO_WEB_ADDRESS_MESSAGE.toLowerCase()}.`);
    } else {
      data.lastName = lastName;
    }
  }

  const partyName = cellFor("partyName");
  if (partyName !== undefined && partyName !== "") {
    // TS-152: the same limit as adding a guest by hand.
    if (partyName.length > 200) errors.push("Household name can be at most 200 characters.");
    else data.partyName = partyName.toUpperCase() === CLEAR_TOKEN ? null : partyName;
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

  const sideRaw = cellFor("side");
  if (sideRaw !== undefined && sideRaw !== "") {
    const normalized = normalizeEnumValue(sideRaw, guestSideEnum.options);
    if (!normalized) {
      errors.push(`Side "${sideRaw}" isn't one of ${guestSideEnum.options.join(", ")}.`);
    } else {
      data.side = normalized;
    }
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
    if (notes.length > 2000) errors.push("Notes can be at most 2000 characters.");
    else data.notes = notes.toUpperCase() === CLEAR_TOKEN ? null : notes;
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

  const { headers, rows: allRows } = parseCsv(csv);
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

  const classified: GuestImportRow[] = numbered.map(({ cells, rowNumber }) => {
    const { errors, data } = parseRow(cells, headers, mapping);

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
      return { rowNumber, kind: "update", guestId, revision: revisionById.get(guestId), preview: data };
    }
    return { rowNumber, kind: "new", preview: data };
  });

  return {
    headers,
    rows: classified,
    summary: {
      newCount: classified.filter((r) => r.kind === "new").length,
      updatingCount: classified.filter((r) => r.kind === "update").length,
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
  actorUserId?: string
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

  // FR-2.9: the Current Plan Version, if any -- fetched once up front since import never
  // generates a new version itself, so it's stable for the whole commit below.
  const { rows: planRows } = await pool.query(
    `SELECT id FROM "plan_versions" WHERE "weddingId" = $1 AND "isCurrent" LIMIT 1`,
    [weddingId]
  );
  const planVersionId: string | undefined = planRows[0]?.id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // TS-92: refuse the whole import (it's all-or-nothing already) if any guest it would update
    // was changed by someone else after the planner previewed it -- otherwise the import would
    // silently overwrite that edit. Rows are locked so nothing can change between this check and
    // the writes below.
    const updateIds = preview.rows.filter((r) => r.kind === "update" && r.guestId).map((r) => r.guestId!);
    if (expectedRevisions && updateIds.length > 0) {
      const { rows: locked } = await client.query<{ id: string; revision: number; name: string }>(
        `SELECT id, revision, ("firstName" || ' ' || "lastName") AS name
         FROM "guests" WHERE "weddingId" = $1 AND id = ANY($2::text[]) FOR UPDATE`,
        [weddingId, updateIds]
      );
      const changed = locked.filter((g) => expectedRevisions[g.id] !== undefined && expectedRevisions[g.id] !== g.revision);
      if (changed.length > 0) {
        throw new GuestImportConflictError(changed.map((g) => g.name));
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

    for (const row of preview.rows) {
      let p = row.preview;
      // TS-169: a row that makes a guest Declined (and doesn't set attendance itself) marks them Not
      // Attending -- the same rule as everywhere else a guest declines (TS-167). For an existing
      // guest, only when this changes their answer.
      if (p.rsvpStatus === "DECLINED" && p.dayOfAttendance === undefined) {
        let changes = true;
        if (row.kind === "update" && row.guestId) {
          const { rows: prev } = await client.query(`SELECT "rsvpStatus" FROM "guests" WHERE id = $1`, [row.guestId]);
          changes = prev[0]?.rsvpStatus !== "DECLINED";
        }
        if (changes) p = { ...p, dayOfAttendance: "NOT_ATTENDING" };
      }
      if (row.kind === "new") {
        await client.query(
          `INSERT INTO "guests"
             (id, "weddingId", "firstName", "lastName", "partyName", headcount, tier, "rsvpStatus",
              "requiresAccessibleTable", "dayOfAttendance", notes, side, "ageCategory", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())`,
          [
            randomUUID(),
            weddingId,
            p.firstName,
            p.lastName,
            p.partyName ?? null,
            p.headcount ?? 1,
            p.tier ?? "OTHER",
            p.rsvpStatus ?? "PENDING",
            p.requiresAccessibleTable ?? false,
            p.dayOfAttendance ?? "ATTENDING",
            encryptText(p.notes ?? null),
            p.side ?? "BOTH",
            p.ageCategory ?? "ADULT",
          ]
        );
        createdCount++;
        if ((p.dayOfAttendance ?? "ATTENDING") === "ATTENDING") attendingAdded = true;
      } else if (row.kind === "update" && row.guestId) {
        const fields: string[] = [];
        const values: unknown[] = [];
        let i = 1;
        if (p.firstName !== undefined) {
          fields.push(`"firstName" = $${i++}`);
          values.push(p.firstName);
        }
        if (p.lastName !== undefined) {
          fields.push(`"lastName" = $${i++}`);
          values.push(p.lastName);
        }
        if ("partyName" in p) {
          fields.push(`"partyName" = $${i++}`);
          values.push(p.partyName ?? null);
        }
        if (p.headcount !== undefined) {
          fields.push(`headcount = $${i++}`);
          values.push(p.headcount);
          // TS-154: the planner's new party size is the guest's new limit.
          fields.push(`"partySizeLimit" = NULL`);
        }
        if (p.tier !== undefined) {
          fields.push(`tier = $${i++}`);
          values.push(p.tier);
        }
        if (p.rsvpStatus !== undefined) {
          fields.push(`"rsvpStatus" = $${i++}`);
          values.push(p.rsvpStatus);
        }
        if (p.requiresAccessibleTable !== undefined) {
          fields.push(`"requiresAccessibleTable" = $${i++}`);
          values.push(p.requiresAccessibleTable);
        }
        if (p.dayOfAttendance !== undefined) {
          fields.push(`"dayOfAttendance" = $${i++}`);
          values.push(p.dayOfAttendance);
        }
        if (p.side !== undefined) {
          fields.push(`side = $${i++}`);
          values.push(p.side);
        }
        if (p.ageCategory !== undefined) {
          fields.push(`"ageCategory" = $${i++}`);
          values.push(p.ageCategory);
        }
        if ("notes" in p) {
          fields.push(`notes = $${i++}`);
          values.push(encryptText(p.notes ?? null));
        }
        if (fields.length > 0) {
          // TS-92: bump revision like every other guest edit, so anyone holding this guest from
          // before the import gets a conflict on their next save instead of overwriting it.
          fields.push(`"updatedAt" = now()`, `revision = revision + 1`);
          values.push(row.guestId, weddingId);
          await client.query(
            `UPDATE "guests" SET ${fields.join(", ")} WHERE id = $${i++} AND "weddingId" = $${i}`,
            values
          );
        }
        updatedCount++;

        // FR-2.9: Attendance Status -> Not Attending frees the seat outright (matching FR-8.1's
        // dedicated day-of behavior, not just a flag) regardless of anything else in this row;
        // otherwise, if any of the other named trigger fields changed, re-check this guest's
        // current assignment (if they have one) against hard rules.
        if (p.dayOfAttendance === "NOT_ATTENDING" && planVersionId) {
          // TS-165: the table they leave (and their rule partners' tables) is re-checked below.
          for (const t of await tablesAffectedBy(client, weddingId, planVersionId, [row.guestId])) recheckTableIds.add(t);
          const { rowCount: freed } = await client.query(
            `DELETE FROM "seat_assignments" WHERE "planVersionId" = $1 AND "guestId" = $2`,
            [planVersionId, row.guestId]
          );
          if (freed) seatsFreed = true;
        } else if (
          planVersionId &&
          (p.side !== undefined ||
            p.tier !== undefined ||
            "partyName" in p ||
            p.requiresAccessibleTable !== undefined ||
            // TS-150: a bigger party can push their table over capacity.
            p.headcount !== undefined)
        ) {
          recheckGuestIds.add(row.guestId);
        }
      }
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
      await client.query(
        `UPDATE "plan_versions" SET "isComplete" = $1${planFlagsChanged || seatsFreed ? ", revision = revision + 1" : ""} WHERE id = $2`,
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
    return { createdCount, updatedCount, warnings: reassignmentWarnings };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
