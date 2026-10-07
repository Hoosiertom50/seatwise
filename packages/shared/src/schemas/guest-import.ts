import { z } from "zod";
import { revisionNumber } from "./common";

// FR-2.4/2.4a: bulk guest import from a CSV file. Column mapping is explicit -- the client tells
// the server which CSV header (by name) corresponds to which guest field; a field left unmapped
// simply isn't touched by the import. "guestId" is the one field that isn't a guest property at
// all: it's how a row identifies an *existing* guest to update rather than create (matching is
// only ever by this explicitly-mapped ID, never by name, per FR-2.4a).
export const guestImportFieldEnum = z.enum([
  "guestId",
  "firstName",
  "lastName",
  "partyName",
  "headcount",
  "tier",
  "rsvpStatus",
  "requiresAccessibleTable",
  "dayOfAttendance",
  "side",
  // TS-210: the export's "Side code" column (BRIDE / GROOM / BOTH, whatever the sides are called) --
  // preferred to the Side names, which can be renamed between the export and the re-import.
  "sideCode",
  "ageCategory",
  "notes",
  // TS-180: the export's "Plus-ones" column (who's coming with the guest).
  "plusOneNames",
  // TS-180: the export's "Version" column -- the guest's revision when the file was exported, so a
  // re-import of an older file can spot guests changed since. Not a guest field itself.
  "version",
]);
export type GuestImportField = z.infer<typeof guestImportFieldEnum>;

export const guestImportMappingSchema = z.record(guestImportFieldEnum, z.string().min(1));
export type GuestImportMapping = z.infer<typeof guestImportMappingSchema>;

export const guestImportRequestSchema = z.object({
  // TS-152: about 2 MB of text -- far more than any guest list (5,000 guests is ~500 KB).
  csv: z.string().min(1, "The file appears to be empty.").max(2_000_000, "That file is too big — keep it under 2 MB."),
  mapping: guestImportMappingSchema,
  // TS-92: on commit, the revision of every guest the preview showed as an "update" -- so a guest
  // someone else edited between preview and confirm is refused rather than silently overwritten.
  // Keyed by guest ID. Omitted on preview (and by older clients, which get the old behavior).
  expectedRevisions: z.record(z.string(), revisionNumber).optional(),
  // TS-180: on commit, the planner ticked "Overwrite guests changed since the export" -- rows the
  // preview showed as conflicts are then written like any other update. Without it they're skipped.
  overwriteChanged: z.boolean().optional(),
  // TS-209: on commit, a key the browser made for this preview. Sending the same import again (its
  // first answer was lost) with the same key gets the first import's answer back -- it isn't
  // imported twice.
  importKey: z.string().uuid().optional(),
});
export type GuestImportRequest = z.infer<typeof guestImportRequestSchema>;

// TS-180: "conflict" -- an update row for a guest changed in Seatwise since the file was exported
// (their revision is newer than the file's Version cell).
// TS-190: "unchanged" -- an update row whose values are the same as the guest's already; it's left
// alone (not written, and the guest's revision isn't bumped).
export type GuestImportRowKind = "new" | "update" | "unchanged" | "conflict" | "error";

export interface GuestImportRowPreview {
  firstName?: string;
  lastName?: string;
  partyName?: string | null;
  headcount?: number;
  tier?: string;
  rsvpStatus?: string;
  requiresAccessibleTable?: boolean;
  dayOfAttendance?: string;
  side?: string;
  ageCategory?: string;
  notes?: string | null;
  // TS-180
  plusOneNames?: string | null;
}

export interface GuestImportRow {
  // 1-based, counting only data rows -- the file's own spreadsheet row is this plus 1 (the header).
  rowNumber: number;
  kind: GuestImportRowKind;
  guestId?: string;
  // TS-92: an "update" (TS-190: or "unchanged") row's guest revision as of this preview -- sent back on commit so the
  // commit can refuse if that guest changed in between.
  revision?: number;
  reason?: string;
  // TS-222: something to know that doesn't stop the row (a Side name that disagrees with the Side code).
  warning?: string;
  preview: GuestImportRowPreview;
}

export interface GuestImportPreview {
  headers: string[];
  rows: GuestImportRow[];
  // TS-180: conflictCount -- rows for guests changed since the export (see GuestImportRowKind).
  // TS-190: unchangedCount -- rows the same as the guest already is.
  summary: {
    newCount: number;
    updatingCount: number;
    unchangedCount: number;
    conflictCount: number;
    errorCount: number;
    totalRows: number;
  };
}

export interface GuestImportCommitResult {
  createdCount: number;
  updatedCount: number;
  // TS-180: conflict rows left alone because the planner didn't choose to overwrite them.
  skippedCount: number;
  // TS-190: rows the same as the guest already is -- not written.
  unchangedCount: number;
  // FR-2.9: guests whose current seat assignment was flagged Needs Reassignment as a result of
  // this import (an edited side/tier/household/requires-accessible-table field no longer fits a
  // hard rule at their current table).
  warnings: string[];
  // TS-209: this answer is the one an earlier try of the same import (same importKey) got -- it
  // wasn't imported again.
  repeated?: boolean;
}
