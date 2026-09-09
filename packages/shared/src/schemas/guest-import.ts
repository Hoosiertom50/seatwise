import { z } from "zod";

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
  "ageCategory",
  "notes",
]);
export type GuestImportField = z.infer<typeof guestImportFieldEnum>;

export const guestImportMappingSchema = z.record(guestImportFieldEnum, z.string().min(1));
export type GuestImportMapping = z.infer<typeof guestImportMappingSchema>;

export const guestImportRequestSchema = z.object({
  csv: z.string().min(1, "The file appears to be empty."),
  mapping: guestImportMappingSchema,
});
export type GuestImportRequest = z.infer<typeof guestImportRequestSchema>;

export type GuestImportRowKind = "new" | "update" | "error";

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
}

export interface GuestImportRow {
  // 1-based, counting only data rows -- the file's own spreadsheet row is this plus 1 (the header).
  rowNumber: number;
  kind: GuestImportRowKind;
  guestId?: string;
  reason?: string;
  preview: GuestImportRowPreview;
}

export interface GuestImportPreview {
  headers: string[];
  rows: GuestImportRow[];
  summary: { newCount: number; updatingCount: number; errorCount: number; totalRows: number };
}

export interface GuestImportCommitResult {
  createdCount: number;
  updatedCount: number;
  // FR-2.9: guests whose current seat assignment was flagged Needs Reassignment as a result of
  // this import (an edited side/tier/household/requires-accessible-table field no longer fits a
  // hard rule at their current table).
  warnings: string[];
}
