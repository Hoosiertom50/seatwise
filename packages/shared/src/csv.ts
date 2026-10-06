// FR-2.4/2.4a: a small hand-rolled CSV parser/serializer (RFC 4180-ish) so bulk guest import and
// export don't need an external dependency. Handles quoted fields containing commas, quotes
// (escaped as ""), and embedded newlines; tolerates \n, \r\n, and a missing trailing newline.

// TS-180: a file the parser can't read safely (an opened quote that never closes) -- the import
// says so rather than guessing where the cell ends.
export class CsvParseError extends Error {}

// TS-180: what a spreadsheet saves at the very start of a "CSV UTF-8" file, and what the export
// now writes so Excel reads accented names correctly.
export const CSV_BOM = "﻿";

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  // TS-180: a leading byte-order mark isn't part of the first header.
  if (text.startsWith(CSV_BOM)) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // TS-180: a quote only opens a quoted cell when it's the cell's first character -- one in the
  // middle of a cell (5" cake, O"Neil) is just a character, as spreadsheets treat it.
  let atFieldStart = true;
  // Where the open quote started, for the error message (row 1 is the header).
  let quoteOpenedOnRow = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      quoteOpenedOnRow = rows.length + 1;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      atFieldStart = true;
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
      i++;
      continue;
    }
    field += c;
    atFieldStart = false;
    i++;
  }
  // TS-180: a quote that never closes swallowed the rest of the file -- refuse it.
  if (inQuotes) {
    throw new CsvParseError(
      `A quote mark (") at the start of a cell in row ${quoteOpenedOnRow} is never closed, so the rest of the file can't be read. Check that cell in your spreadsheet and save the file again.`
    );
  }
  // Final field/row when the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop a trailing fully-blank row (a common trailing-newline artifact).
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }

  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows: rows.map((r) => r.map(fromSpreadsheetSafe)) };
}

/** TS-180: the first header name used by two columns (blank headers aside), or null. */
export function findDuplicateCsvHeader(headers: string[]): string | null {
  const seen = new Set<string>();
  for (const h of headers) {
    if (h === "") continue;
    if (seen.has(h)) return h;
    seen.add(h);
  }
  return null;
}

/** TS-180: what the import says about two columns with the same name. */
export function duplicateCsvHeaderMessage(header: string): string {
  return `Two columns are both called "${header}" — rename one, then choose the file again.`;
}

// TS-125: a cell that starts with = + - @ (or a tab/CR) is run as a formula by Excel, Numbers and
// Google Sheets. Guest RSVP notes are typed by anyone holding a public RSVP link, so the export
// neutralises such cells with a leading apostrophe (OWASP's CSV-injection guidance) -- spreadsheets
// show it as plain text -- and parseCsv strips exactly that apostrophe back off, so an exported file
// re-imports unchanged.
// TS-180: the same goes for the start of each line or piece inside a cell (after ; a line break or
// a tab), since some spreadsheets split cells there. An apostrophe already in such a spot gets one
// more in front, so stripping exactly one on import always gives back the original text.
const FORMULA_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"]);
const PIECE_BREAKS = new Set([";", "\n", "\r", "\t"]);

function startsPiece(value: string, i: number): boolean {
  return i === 0 || PIECE_BREAKS.has(value[i - 1]);
}

/** Whether value[i..] is any number of apostrophes and then a formula character. */
function looksLikeFormulaAt(value: string, i: number): boolean {
  let j = i;
  while (value[j] === "'") j++;
  return j < value.length && FORMULA_CHARS.has(value[j]);
}

export function toSpreadsheetSafe(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (startsPiece(value, i) && looksLikeFormulaAt(value, i)) out += "'";
    out += value[i];
  }
  return out;
}

export function fromSpreadsheetSafe(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "'" && startsPiece(value, i) && looksLikeFormulaAt(value, i + 1)) continue;
    out += value[i];
  }
  return out;
}

function csvEscape(raw: string): string {
  const value = toSpreadsheetSafe(raw);
  // TS-180: a ; is quoted too -- spreadsheets set to a ; separator would split the cell there.
  if (/[",;\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsvRow(fields: string[]): string {
  return fields.map(csvEscape).join(",");
}

/** TS-180: starts with a byte-order mark, so Excel reads it as UTF-8 (accented names). */
export function toCsv(headers: string[], rows: string[][]): string {
  return CSV_BOM + [toCsvRow(headers), ...rows.map(toCsvRow)].join("\r\n") + "\r\n";
}
