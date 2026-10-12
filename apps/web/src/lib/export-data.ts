import {
  getWeddingAccessLevel,
  getWeddingById,
  getPlanVersionDetail,
  listGuestsByWedding,
  listSeatingTablesForWedding,
  type PlanVersionDetail,
  type PlanVersionAssignmentRow,
} from "@seatwise/db";
import { compareTableLabels, plusOnesToPrint } from "@seatwise/shared";
import type { ExportGuestRow } from "./pdf";
import { compareGuestNames } from "./guest-name-order";

export class ExportNotFoundError extends Error {}
export class ExportNotReadyError extends Error {}

export interface ExportData {
  weddingName: string;
  planVersion: PlanVersionDetail;
  // Every seated guest (TS-250: not those flagged "Needs reassignment"), sorted the same way the rest of the app sorts a guest list (last name,
  // then first name) — this is what "alphabetical" means everywhere else in Seatwise.
  sortedRows: ExportGuestRow[];
  tables: { label: string; guestNames: string[] }[];
  // TS-211: attending guests with no seat in this plan (added, or back to Attending, since it was
  // made) -- the PDFs list them under "Not seated" rather than quietly leaving them out. Same order
  // as sortedRows.
  unseated: { guestName: string; plusOneNames: string | null }[];
  // TS-250: guests whose seat was flagged "Needs reassignment" after the plan was approved, with the
  // table they're at now -- printed under "Needs reassignment", never at that table. Same order.
  needsReassignment: ExportGuestRow[];
  // TS-211: when the PDF was made, as printed on it (MM-DD-YYYY, 12-hour, in the viewer's time zone).
  generatedAt: string;
}

/**
 * TS-211: "Generated 10-07-2026 3:45 PM EDT" -- the moment, in `timeZone` when it's a real IANA time
 * zone (the browser sends its own), otherwise UTC (said so).
 */
export function formatGeneratedAt(moment: Date, timeZone?: string | null): string {
  let zone = "UTC";
  if (timeZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      zone = timeZone;
    } catch {
      // Not a time zone -- UTC it is.
    }
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    })
      .formatToParts(moment)
      .map((p) => [p.type, p.value])
  );
  return `Generated ${parts.month}-${parts.day}-${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

/** TS-250: the guest fields arrangeExportGuests reads. */
export interface ExportGuest {
  id: string;
  firstName: string;
  lastName: string;
  headcount: number;
  plusOneNames: string | null;
  dayOfAttendance: string;
}

/**
 * Splits a plan's guests the way every PDF prints them: who sits at which table, the alphabetical
 * list, attending guests with no seat (TS-211) and -- TS-250 -- guests whose seat needs changing
 * (flagged "Needs reassignment" after approval: a party grew, a table got smaller, a new must-not
 * rule...). Those used to be printed at that table as if all was well; now they're left off the
 * table and the alphabetical list, and listed on their own with the table they're at.
 */
export function arrangeExportGuests(
  assignments: Pick<PlanVersionAssignmentRow, "guestId" | "guestName" | "tableId" | "tableLabel" | "needsReassignment">[],
  guests: ExportGuest[],
  allTables: { id: string; label: string }[]
): Pick<ExportData, "sortedRows" | "tables" | "unseated" | "needsReassignment"> {
  // TS-190: last name, then first name, compared one after the other (see compareGuestNames).
  const nameById = new Map(guests.map((g) => [g.id, { firstName: g.firstName, lastName: g.lastName }]));
  const nameOf = (a: { guestId: string; guestName: string }) =>
    nameById.get(a.guestId) ?? { lastName: a.guestName, firstName: "" };

  const sortedAssignments = [...assignments].sort((a, b) => compareGuestNames(nameOf(a), nameOf(b)));

  // TS-180: who's coming with each guest, for the lookup list (plus-ones aren't private -- View
  // and Comment collaborators see them in the app too).
  // TS-198: only for a party bigger than one (see plusOnesToPrint).
  const plusOnesById = new Map(guests.map((g) => [g.id, plusOnesToPrint(g)]));
  const toRow = (a: (typeof sortedAssignments)[number]): ExportGuestRow => ({
    guestName: a.guestName,
    tableLabel: a.tableLabel,
    plusOneNames: plusOnesById.get(a.guestId) ?? null,
    needsReassignment: a.needsReassignment,
  });
  // TS-250: a flagged guest isn't validly seated -- not at the table, but in a list of their own.
  const sortedRows = sortedAssignments.filter((a) => !a.needsReassignment).map(toRow);
  const needsReassignment = sortedAssignments.filter((a) => a.needsReassignment).map(toRow);

  // TS-180: grouped by table, not by name -- two tables with the same name used to be merged into
  // one -- and every table in the plan is listed, empty ones included (with "no one seated here").
  const byTable = new Map<string, { label: string; guestNames: string[] }>(
    allTables.map((t) => [t.id, { label: t.label, guestNames: [] }])
  );
  for (const a of sortedAssignments) {
    if (!byTable.has(a.tableId)) byTable.set(a.tableId, { label: a.tableLabel, guestNames: [] });
    // TS-250: a flagged guest isn't printed at the table that no longer works for them.
    if (!a.needsReassignment) byTable.get(a.tableId)!.guestNames.push(a.guestName);
  }
  const tables = [...byTable.values()].sort((a, b) => compareTableLabels(a.label, b.label));

  // TS-211: an approved plan can lose completeness later (a guest added, or one who declined coming
  // back) -- those attending guests have no seat, and used to be left off every PDF without a word.
  const seatedIds = new Set(assignments.map((a) => a.guestId));
  const unseated = guests
    .filter((g) => g.dayOfAttendance === "ATTENDING" && !seatedIds.has(g.id))
    .sort(compareGuestNames)
    .map((g) => ({ guestName: `${g.firstName} ${g.lastName}`, plusOneNames: plusOnesToPrint(g) }));

  return { sortedRows, tables, unseated, needsReassignment };
}

// FR-9.1/9.2/9.3 all read "Given an approved plan..." — exports are gated on Approved so nobody
// hands out a chart, lookup list, or place cards for a plan that's still being worked on and
// could change under them (FR-0.1's spirit: never hand someone a result that isn't actually
// settled).
export async function loadExportData(
  weddingId: string,
  planVersionId: string,
  userId: string,
  /** TS-211: the viewer's time zone, for the generated date and time printed on the PDF. */
  timeZone?: string | null
): Promise<ExportData> {
  // Exporting is a read — any View-level collaborator can download an already-Approved plan,
  // not just the owner.
  const accessLevel = await getWeddingAccessLevel(weddingId, userId);
  if (!accessLevel) throw new ExportNotFoundError("Wedding not found");
  const wedding = await getWeddingById(weddingId);
  if (!wedding) throw new ExportNotFoundError("Wedding not found");

  const planVersion = await getPlanVersionDetail(planVersionId, weddingId);
  if (!planVersion) throw new ExportNotFoundError("Plan version not found");
  if (planVersion.status !== "APPROVED") {
    throw new ExportNotReadyError(
      "This plan isn't Approved yet — approve it on the Seating plan tab before exporting."
    );
  }
  // TS-179: an approved version that has since been replaced (by a newer Generate or Restore) is
  // no longer the plan in use, so its chart, list or cards would be out of date.
  if (!planVersion.isCurrent) {
    throw new ExportNotReadyError(
      `Version ${planVersion.versionNumber} isn't the current plan any more — open the current plan on the Seating plan tab (and approve it) to export.`
    );
  }

  const guests = await listGuestsByWedding(weddingId);
  const allTables = await listSeatingTablesForWedding(weddingId);
  // TS-250: who goes where on the PDFs -- see arrangeExportGuests.
  const { sortedRows, tables, unseated, needsReassignment } = arrangeExportGuests(
    planVersion.assignments,
    guests,
    allTables
  );

  return {
    weddingName: wedding.name,
    planVersion,
    sortedRows,
    tables,
    unseated,
    needsReassignment,
    generatedAt: formatGeneratedAt(new Date(), timeZone),
  };
}
