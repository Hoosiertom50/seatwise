// FR-2.4/2.4a: a small hand-rolled CSV parser/serializer (RFC 4180-ish) so bulk guest import and
// export don't need an external dependency. Handles quoted fields containing commas, quotes
// (escaped as ""), and embedded newlines; tolerates \n, \r\n, and a missing trailing newline.
// TS-210: also a lone \r, and tab- or semicolon-separated files (see detectCsvDelimiter).

// TS-180: a file the parser can't read safely (an opened quote that never closes) -- the import
// says so rather than guessing where the cell ends.
export class CsvParseError extends Error {}

// TS-180: what a spreadsheet saves at the very start of a "CSV UTF-8" file, and what the export
// now writes so Excel reads accented names correctly.
export const CSV_BOM = "﻿";

// TS-210: which character separates the cells -- a comma, or the tab (Excel's "Unicode Text") or
// semicolon (Excel in much of Europe) when the header line has more of those than commas. Before,
// such a file was read as one column.
export function detectCsvDelimiter(text: string): "," | "\t" | ";" {
  const counts = { ",": 0, "\t": 0, ";": 0 };
  // Quotes are read the way parseCsv reads them (Copilot review): a quote only opens a quoted cell
  // at the start of a cell, and "" inside one is a quote; anywhere else (5" cake) it's a plain
  // character. Counting every quote used to flip in and out of "quoted" on those and miscount.
  let inQuotes = false;
  let atCellStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (c === "\n" || c === "\r") break;
    if (c === '"' && atCellStart) {
      inQuotes = true;
      atCellStart = false;
      continue;
    }
    if (c === "," || c === "\t" || c === ";") {
      counts[c]++;
      atCellStart = true;
      continue;
    }
    atCellStart = false;
  }
  if (counts["\t"] > counts[","] && counts["\t"] >= counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  // TS-180: a leading byte-order mark isn't part of the first header.
  if (text.startsWith(CSV_BOM)) text = text.slice(1);
  const delimiter = detectCsvDelimiter(text);
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
    if (c === delimiter) {
      row.push(field);
      field = "";
      atFieldStart = true;
      i++;
      continue;
    }
    // TS-210: a carriage return on its own (classic Mac line endings, or one left inside a cell) is a
    // line break too -- it used to be dropped, joining the text either side. \r\n is one break.
    if (c === "\r" && text[i + 1] === "\n") {
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
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

  // TS-222: headers are unescaped like cells. The import re-sends the mapped columns through toCsv,
  // which makes a "+1" header "'+1" -- the server then didn't find the mapped "+1" column and
  // silently imported every row without it.
  const headers = (rows.shift() ?? []).map((h) => fromSpreadsheetSafe(h.trim()));
  return { headers, rows: rows.map((r) => r.map(fromSpreadsheetSafe)) };
}

/**
 * TS-225: the row number a planner sees in their spreadsheet for an import's data row (data row 1 is
 * the spreadsheet's row 2, under the header). The preview and the "older Mac format" message used
 * to show data row numbers, one less than the unclosed-quote message and the spreadsheet.
 */
export function spreadsheetRowNumber(dataRowNumber: number): number {
  return dataRowNumber + 1;
}

// TS-233: the most columns an import file can have -- a guest file needs a few dozen at most, and a
// header row hundreds of thousands of columns wide made each preview slow.
export const MAX_IMPORT_COLUMNS = 200;

/** TS-233: what the import says about a file with more than MAX_IMPORT_COLUMNS columns. */
export function tooManyColumnsMessage(columnCount: number): string {
  return `That file has ${columnCount.toLocaleString("en-US")} columns — keep it to at most ${MAX_IMPORT_COLUMNS} (delete the columns you don't need), then choose it again.`;
}

/**
 * TS-233: each header name's column, built once per import (the first column with that name, as
 * indexOf would find) -- looking every cell's header up again was slow on a wide file.
 */
export function headerIndexMap(headers: readonly string[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  headers.forEach((h, i) => {
    if (!map.has(h)) map.set(h, i);
  });
  return map;
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
  // TS-243: and a tab -- the import re-sends the mapped columns as CSV, and an unquoted tab in a
  // header made the server read the whole file as tab-separated.
  if (/[",;\n\r\t]/.test(value)) {
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
