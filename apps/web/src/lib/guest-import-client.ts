// TS-209 / TS-210: the Guests tab's import steps that don't need the screen -- kept here so they can
// be unit tested (guest-import-client.test.mts).
import {
  parseCsv,
  toCsv,
  spreadsheetRowNumber,
  findMacRomanCell,
  MAX_IMPORT_COLUMNS,
  tooManyColumnsMessage,
  MAC_ENCODING_MESSAGE,
  type CsvTextEncoding,
  type GuestImportField,
  type GuestImportPreview,
  type GuestImportRow,
} from "@seatwise/shared";
import { ApiError, NETWORK_ERROR_STATUS } from "./api-client";

// TS-210: the columns that hold names -- where a curly quote between two small letters is a sign of
// the older Mac format ("Mar’a" for María).
// TS-233: first and last name only -- in Household or Plus-ones, "Bride’s college friends" or
// "Sarah’s husband Tom" is ordinary Windows text, and was refused.
const NAME_FIELDS: GuestImportField[] = ["firstName", "lastName"];

/**
 * TS-210: the file as the import sends it -- only the mapped columns (so a wedding's own export, with
 * every guest's RSVP note in a column the import never uses, isn't too big to import again), always
 * comma-separated. Every row is kept, blank ones too, so row numbers still match the spreadsheet.
 * A file read as windows-1252 is first checked for the older Mac format, in the mapped cells only.
 */
export function prepareImportCsv(
  text: string,
  encoding: CsvTextEncoding,
  mapping: Partial<Record<GuestImportField, string>>
): { csv: string } | { error: string } {
  const { headers, rows } = parseCsv(text);
  // TS-233: the same column limit as the server's.
  if (headers.length > MAX_IMPORT_COLUMNS) return { error: tooManyColumnsMessage(headers.length) };
  const mapped = [...new Set(Object.values(mapping).filter((h): h is string => !!h))];
  // TS-222: a mapped column the file doesn't have is refused, not quietly left out (that used to
  // import every row without it, with no error).
  const missing = mapped.find((h) => !headers.includes(h));
  if (missing !== undefined) return { error: mappedColumnMissingMessage(missing) };
  const columns = mapped.map((h) => headers.indexOf(h));
  if (encoding === "windows-1252") {
    const nameColumns = NAME_FIELDS.map((f) => (mapping[f] ? headers.indexOf(mapping[f]!) : -1)).filter((i) => i !== -1);
    const found = findMacRomanCell(rows, columns, nameColumns);
    if (found) return { error: `${MAC_ENCODING_MESSAGE} (First seen in row ${spreadsheetRowNumber(found.rowNumber)}, column "${headers[found.column]}".)` };
  }
  // A row that is blank in every column (a spacer) stays a row, so later row numbers don't move.
  return { csv: toCsv(mapped, rows.map((cells) => columns.map((c) => cells[c] ?? ""))) };
}

/** TS-222 */
export function mappedColumnMissingMessage(header: string): string {
  return `This file has no column called "${header}" — choose the file again and check the column choices.`;
}

/**
 * TS-209: the commit's own list of rows that still have errors, put into the preview in place of
 * those rows -- the screen used to say "N rows still have errors" and show none of them.
 */
export function withCommitErrorRows(preview: GuestImportPreview, errorRows: GuestImportRow[]): GuestImportPreview {
  const byNumber = new Map(errorRows.map((r) => [r.rowNumber, r]));
  const known = new Set(preview.rows.map((r) => r.rowNumber));
  const rows = [
    ...preview.rows.map((r) => byNumber.get(r.rowNumber) ?? r),
    ...errorRows.filter((r) => !known.has(r.rowNumber)),
  ].sort((a, b) => a.rowNumber - b.rowNumber);
  const count = (kind: GuestImportRow["kind"]) => rows.filter((r) => r.kind === kind).length;
  return {
    ...preview,
    rows,
    summary: {
      newCount: count("new"),
      updatingCount: count("update"),
      unchangedCount: count("unchanged"),
      conflictCount: count("conflict"),
      errorCount: count("error"),
      totalRows: rows.length,
    },
  };
}

/** TS-209: the rows a refused commit sent back (see the commit route), or null. */
export function commitErrorRows(err: unknown): GuestImportRow[] | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const rows = err.data?.rows;
  return Array.isArray(rows) && rows.length > 0 ? (rows as GuestImportRow[]) : null;
}

/**
 * TS-209: whether a failed import might still have gone in -- no answer at all, or a server error
 * (not a refusal, a 4xx, nor the "too busy, nothing was saved" 503). The list is then loaded again
 * and the planner asked to check it before importing again.
 */
export function importMayHaveSaved(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  if (err.status === NETWORK_ERROR_STATUS) return true;
  return err.status >= 500 && err.status !== 503;
}

export const CHECK_LIST_BEFORE_IMPORTING_AGAIN =
  "The import may have gone in — the guest list below has been loaded again. Check the list before importing again.";
