import { randomUUID } from "crypto";
import { pool } from "../pool";
import { encryptText } from "../crypto";
import { checkGuestHardRuleViolation } from "./plan-versions";
import {
  parseCsv,
  guestTierEnum,
  rsvpStatusEnum,
  dayOfAttendanceEnum,
  guestSideEnum,
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
    data.firstName = firstName;
    data.lastName = lastName;
  }

  const partyName = cellFor("partyName");
  if (partyName !== undefined && partyName !== "") {
    data.partyName = partyName.toUpperCase() === CLEAR_TOKEN ? null : partyName;
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

  const notes = cellFor("notes");
  if (notes !== undefined && notes !== "") {
    data.notes = notes.toUpperCase() === CLEAR_TOKEN ? null : notes;
  }

  return { errors, data };
}

export async function classifyGuestImport(
  weddingId: string,
  csv: string,
  mapping: GuestImportMapping
): Promise<GuestImportPreview> {
  if (!mapping.firstName || !mapping.lastName) {
    throw new GuestImportError('Map "First name" and "Last name" to a column before importing.');
  }

  const { headers, rows } = parseCsv(csv);

  const { rows: existingGuests } = await pool.query<{ id: string }>(
    `SELECT id FROM "guests" WHERE "weddingId" = $1`,
    [weddingId]
  );
  const existingIds = new Set(existingGuests.map((g) => g.id));

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

  const classified: GuestImportRow[] = rows.map((cells, index) => {
    const rowNumber = index + 1;
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
      return { rowNumber, kind: "update", guestId, preview: data };
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
  mapping: GuestImportMapping
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
    `SELECT id FROM "plan_versions" WHERE "weddingId" = $1 ORDER BY "versionNumber" DESC LIMIT 1`,
    [weddingId]
  );
  const planVersionId: string | undefined = planRows[0]?.id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let createdCount = 0;
    let updatedCount = 0;
    // FR-2.9: names of guests whose current assignment was flagged Needs Reassignment by this
    // import, surfaced to the caller the same way TS-7's table-side re-check surfaces warnings.
    const reassignmentWarnings: string[] = [];

    for (const row of preview.rows) {
      const p = row.preview;
      if (row.kind === "new") {
        await client.query(
          `INSERT INTO "guests"
             (id, "weddingId", "firstName", "lastName", "partyName", headcount, tier, "rsvpStatus",
              "requiresAccessibleTable", "dayOfAttendance", notes, side, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
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
          ]
        );
        createdCount++;
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
        if ("notes" in p) {
          fields.push(`notes = $${i++}`);
          values.push(encryptText(p.notes ?? null));
        }
        if (fields.length > 0) {
          fields.push(`"updatedAt" = now()`);
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
          await client.query(
            `DELETE FROM "seat_assignments" WHERE "planVersionId" = $1 AND "guestId" = $2`,
            [planVersionId, row.guestId]
          );
        } else if (
          planVersionId &&
          (p.side !== undefined ||
            p.tier !== undefined ||
            "partyName" in p ||
            p.requiresAccessibleTable !== undefined)
        ) {
          const { rows: assignRows } = await client.query(
            `SELECT id, "seatingTableId" AS "tableId" FROM "seat_assignments"
             WHERE "planVersionId" = $1 AND "guestId" = $2`,
            [planVersionId, row.guestId]
          );
          const assignment = assignRows[0] as { id: string; tableId: string } | undefined;
          if (assignment) {
            const { rows: guestRows } = await client.query(
              `SELECT ("firstName" || ' ' || "lastName") AS name, "requiresAccessibleTable"
               FROM "guests" WHERE id = $1`,
              [row.guestId]
            );
            const guest = guestRows[0] as { name: string; requiresAccessibleTable: boolean };
            const violated = await checkGuestHardRuleViolation(
              client,
              weddingId,
              planVersionId,
              row.guestId,
              assignment.tableId,
              guest.requiresAccessibleTable
            );
            await client.query(
              `UPDATE "seat_assignments" SET "needsReassignment" = $1, "updatedAt" = now() WHERE id = $2`,
              [violated, assignment.id]
            );
            if (violated) {
              reassignmentWarnings.push(
                `${guest.name}'s current table no longer fits a hard rule for them — flagged as Needs Reassignment.`
              );
            }
          }
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
      await client.query(`UPDATE "plan_versions" SET "isComplete" = $1 WHERE id = $2`, [
        isComplete,
        planVersionId,
      ]);
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
