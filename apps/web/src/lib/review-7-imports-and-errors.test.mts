// TS-209 / TS-210 / TS-211: unit tests for review 7's fixes -- reading guest files (a stray byte, real
// Windows and old Mac files, tab and semicolon files, lone carriage returns, side codes, headcounts,
// only the mapped columns sent), saved changes never answered as failures (database time-outs,
// repeated imports, deletes of things already gone), and the exports (the "Not seated" section, the
// generated date and time, failures said in words). Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCsvFile,
  CsvEncodingError,
  MIXED_ENCODING_MESSAGE,
  findMacRomanCell,
  looksLikeMacRoman,
} from "../../../../packages/shared/src/text-decode";
import { parseCsv, toCsv, detectCsvDelimiter } from "../../../../packages/shared/src/csv";
import { parseGuestImportRow } from "../../../../packages/shared/src/guest-import-row";
import { parseGuestSideCode, guestSideLabel } from "../../../../packages/shared/src/guest-side";
import { guestImportRequestSchema } from "../../../../packages/shared/src/schemas/guest-import";
import type { GuestImportPreview } from "../../../../packages/shared/src/schemas/guest-import";
import { ApiError, NETWORK_ERROR_STATUS, isWeddingGone404, isItemGoneError } from "./api-client";
import { prepareImportCsv, withCommitErrorRows, commitErrorRows, importMayHaveSaved } from "./guest-import-client";
import { exportErrorMessage, exportUrl, unseatedExportWarning } from "./export-download";
import { afterSave, SAVED_BUT_NOT_REFRESHED } from "./post-save";

const SIDES = { sideLabel1: "Bride", sideLabel2: "Groom" };
const win1252 = (s: string) => {
  // Encode with the windows-1252 table (the letters these tests use).
  const extra: Record<string, number> = { "Š": 0x8a, "š": 0x9a, "Ž": 0x8e, "ž": 0x9e, "–": 0x96, "—": 0x97, "™": 0x99, "’": 0x92 };
  return new Uint8Array([...s].map((ch) => extra[ch] ?? ch.charCodeAt(0)));
};

// --- TS-210 item 1: one stray byte ---

test("a UTF-8 file with the byte-order mark and one stray byte keeps every other letter, and only that cell is flagged", () => {
  const csv = toCsv(["First name", "Last name", "Notes"], [["Jesús", "Lee", "Vegan entrée"], ["Zoë", "Núñez", "ok"]]);
  const bytes = Buffer.from(csv, "utf8");
  // A stray 0xE9 straight after "Lee".
  const at = bytes.indexOf(Buffer.from("Lee", "utf8")) + 3;
  const broken = new Uint8Array([...bytes.subarray(0, at), 0xe9, ...bytes.subarray(at)]);
  const { text, encoding } = decodeCsvFile(broken);
  assert.equal(encoding, "utf-8");
  const { headers, rows } = parseCsv(text);
  assert.deepEqual(rows[0], ["Jesús", "Lee�", "Vegan entrée"]);
  assert.deepEqual(rows[1], ["Zoë", "Núñez", "ok"]);
  const mapping = { firstName: "First name", lastName: "Last name", notes: "Notes" };
  const first = parseGuestImportRow(rows[0], headers, mapping, SIDES);
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0], /Last name "Lee�" has characters that couldn't be read/);
  assert.equal(first.data.firstName, "Jesús");
  assert.equal(parseGuestImportRow(rows[1], headers, mapping, SIDES).errors.length, 0);
});

test("without the byte-order mark, a mostly-UTF-8 file with a stray byte is refused, not garbled", () => {
  const bytes = Buffer.from("First name,Last name\r\nJesús,Lee\r\n", "utf8");
  const broken = new Uint8Array([...bytes, 0xe9]);
  assert.throws(() => decodeCsvFile(broken), (err: unknown) => err instanceof CsvEncodingError && (err as Error).message === MIXED_ENCODING_MESSAGE);
});

// --- TS-210 item 2: real Windows files, old Mac files ---

test("a genuine Windows file with š ž Š Ž, dashes and ™ is read, not refused as the Mac format", () => {
  const text = "First name,Last name,Notes\r\nKašpar,Božena,vegan—no nuts\r\nŽeljko,Žižek,Seatwise™\r\nMary–Kate,Šimek,x\r\n";
  const { text: read, encoding } = decodeCsvFile(win1252(text));
  assert.equal(encoding, "windows-1252");
  assert.equal(read, text);
  const { rows } = parseCsv(read);
  assert.equal(findMacRomanCell(rows, [0, 1, 2], [0, 1]), null);
});

test("an old Mac file's í, ø and ß are caught in name cells (’ between small letters, ¿, §)", () => {
  // Mac Roman bytes: í = 92 (’ in windows-1252), ø = BF (¿), ß = A7 (§).
  const bytes = new Uint8Array([
    ...Buffer.from("First name,Last name\r\nMar", "ascii"), 0x92, ...Buffer.from("a,S", "ascii"), 0xbf,
    ...Buffer.from("ren\r\nAnna,Strau", "ascii"), 0xa7, ...Buffer.from("\r\n", "ascii"),
  ]);
  const { text, encoding } = decodeCsvFile(bytes);
  assert.equal(encoding, "windows-1252");
  const { rows } = parseCsv(text);
  assert.deepEqual(findMacRomanCell(rows, [0, 1], [0, 1]), { rowNumber: 1, column: 0 });
  assert.equal(looksLikeMacRoman("Mar’a", true), true);
  assert.equal(looksLikeMacRoman("S¿ren", true), true);
  assert.equal(looksLikeMacRoman("Strau§", true), true);
  // Not in a notes cell, and a real O’Brien is fine.
  assert.equal(looksLikeMacRoman("it’s fine", false), false);
  assert.equal(looksLikeMacRoman("O’Brien", true), false);
});

test("only mapped columns are checked for the Mac format, and only they are sent", () => {
  const text = "First name,Last name,Guest's RSVP note\r\nAnna,Lee,RenŽe says hi\r\n\r\nBo,Ray,x\r\n";
  const ok = prepareImportCsv(text, "windows-1252", { firstName: "First name", lastName: "Last name" });
  assert.ok("csv" in ok);
  // The unmapped note column is gone; the blank row stays so row numbers still match.
  assert.deepEqual(parseCsv(ok.csv), { headers: ["First name", "Last name"], rows: [["Anna", "Lee"], ["", ""], ["Bo", "Ray"]] });
  const refused = prepareImportCsv(text, "windows-1252", { firstName: "First name", lastName: "Guest's RSVP note" });
  assert.ok("error" in refused && /older Mac format/.test(refused.error) && /row 1/.test(refused.error));
  // A UTF-8 file is never checked for it.
  assert.ok("csv" in prepareImportCsv(text, "utf-8", { firstName: "First name", lastName: "Guest's RSVP note" }));
});

test("a wedding's own export stays under the size limit once unmapped columns are left out", () => {
  const note = "n".repeat(2000);
  const rows = Array.from({ length: 1200 }, (_, i) => [`g${i}`, "Ann", "Lee", note]);
  const exported = toCsv(["Guest ID", "First name", "Last name", "Guest's RSVP note"], rows);
  assert.ok(exported.length > 2_000_000);
  const prepared = prepareImportCsv(exported, "utf-8", { guestId: "Guest ID", firstName: "First name", lastName: "Last name" });
  assert.ok("csv" in prepared);
  assert.equal(guestImportRequestSchema.safeParse({ csv: prepared.csv, mapping: { firstName: "First name", lastName: "Last name" } }).success, true);
});

// --- TS-210 item 3: side codes ---

test("renamed side names don't move guests: the export's Side code wins, and a disagreeing Side cell is an error", () => {
  // Exported as Bride / Groom, then the sides renamed to Groom / Partner.
  // A GROOM guest's row as the export wrote it: the side's name then, and the stored code.
  const exported = [[guestSideLabel("GROOM", "Bride", "Groom"), "GROOM"]];
  const headers = ["Side", "Side code"];
  const renamed = { sideLabel1: "Groom", sideLabel2: "Partner" };
  const codeOnly = { firstName: "F", lastName: "L", sideCode: "Side code" } as const;
  const both = { firstName: "F", lastName: "L", side: "Side", sideCode: "Side code" } as const;
  const h = ["F", "L", ...headers];
  // Code only: the stored side, whatever the names are now.
  assert.equal(parseGuestImportRow(["A", "B", ...exported[0]], h, codeOnly, renamed).data.side, "GROOM");
  // Both mapped: "Groom" now means the first side (BRIDE) but the code says GROOM -- said, not swapped.
  const row = parseGuestImportRow(["A", "B", ...exported[0]], h, both, renamed);
  assert.equal(row.data.side, undefined);
  assert.match(row.errors.join(" "), /don't agree/);
  // A Side name that no longer exists is fine with a code.
  assert.equal(parseGuestImportRow(["A", "B", "Bride", "BRIDE"], h, both, { sideLabel1: "Alex", sideLabel2: "Sam" }).data.side, "BRIDE");
  // Agreeing cells are fine.
  assert.equal(parseGuestImportRow(["A", "B", "Partner", "GROOM"], h, both, renamed).data.side, "GROOM");
  assert.ok("error" in parseGuestSideCode("SIDE A"));
  assert.deepEqual(parseGuestSideCode(" groom "), { side: "GROOM" });
});

// --- TS-210 item 4: odd formats, headcount ---

test("tab- and semicolon-separated files are read as columns; a lone carriage return is a line break", () => {
  assert.equal(detectCsvDelimiter("First name\tLast name\r\nA\tB"), "\t");
  assert.deepEqual(parseCsv("First name\tLast name\r\nAnn\tLee\r\n"), { headers: ["First name", "Last name"], rows: [["Ann", "Lee"]] });
  assert.deepEqual(parseCsv("First name;Last name\nAnn;Lee\n"), { headers: ["First name", "Last name"], rows: [["Ann", "Lee"]] });
  // A comma file whose cells hold semicolons stays a comma file.
  assert.deepEqual(parseCsv('First name,Notes\nAnn,"a;b;c"\n').rows, [["Ann", "a;b;c"]]);
  // Classic Mac line endings, and a stray \r inside an unquoted cell.
  assert.deepEqual(parseCsv("First name,Last name\rAnn,Lee\rBo,Ray\r").rows, [["Ann", "Lee"], ["Bo", "Ray"]]);
  assert.deepEqual(parseCsv("A,B\r\nx\ry,z\r\n").rows, [["x"], ["y", "z"]]);
  // Inside quotes it's still part of the cell.
  assert.deepEqual(parseCsv('A\n"x\ry"\n').rows, [["x\ry"]]);
});

test("UTF-16 without a byte-order mark is read as UTF-16", () => {
  const le = new Uint8Array(Buffer.from("First name,Last name\r\nRenée,Müller\r\n", "utf16le"));
  const { text, encoding } = decodeCsvFile(le);
  assert.equal(encoding, "utf-16");
  assert.deepEqual(parseCsv(text).rows, [["Renée", "Müller"]]);
});

test("headcount takes plain digits only -- 0x10, 1e1 and 0b11 are refused", () => {
  const headers = ["F", "L", "H"];
  const mapping = { firstName: "F", lastName: "L", headcount: "H" };
  for (const bad of ["0x10", "1e1", "0b11", "2.0", "+3", "-1", "0", "21"]) {
    assert.match(parseGuestImportRow(["A", "B", bad], headers, mapping, SIDES).errors.join(), /whole number between 1 and 20/, bad);
  }
  assert.equal(parseGuestImportRow(["A", "B", "3"], headers, mapping, SIDES).data.headcount, 3);
  assert.equal(parseGuestImportRow(["A", "B", "07"], headers, mapping, SIDES).data.headcount, 7);
});

// --- TS-209: saved changes, timeouts, imports, deletes ---

test("a statement time-out, an aborted transaction or no free connection is 503 + Retry-After, 'nothing was saved'", async () => {
  const { concurrentChangeResponse, databaseBusyResponse, DATABASE_BUSY_MESSAGE } = await import("./api-response");
  for (const err of [
    Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
    Object.assign(new Error("current transaction is aborted"), { code: "25P02" }),
    new Error("timeout exceeded when trying to connect"),
  ]) {
    const res = concurrentChangeResponse(err);
    assert.ok(res, err.message);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Retry-After"), "60");
    assert.equal((await res.json()).error, DATABASE_BUSY_MESSAGE);
  }
  assert.match(DATABASE_BUSY_MESSAGE, /nothing was saved/);
  assert.equal(databaseBusyResponse(new Error("something else")), null);
  // A deadlock is still the 409 "try again".
  assert.equal(concurrentChangeResponse(Object.assign(new Error("deadlock"), { code: "40P01" }))?.status, 409);
});

test("a step after the save that fails gives its fallback and a warning, never an error", async () => {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const got = await afterSave("reading back", async () => { throw new Error("db down"); }, warnings, SAVED_BUT_NOT_REFRESHED, "fallback");
    assert.equal(got, "fallback");
    assert.deepEqual(warnings, [SAVED_BUT_NOT_REFRESHED]);
    assert.equal(errors.length, 1);
    assert.equal(await afterSave("reading back", async () => "fine", warnings, SAVED_BUT_NOT_REFRESHED, "fallback"), "fine");
  } finally {
    console.error = original;
  }
});

test("an import sent again with the same key gets the first answer back and imports nothing", async () => {
  const db = await import("@seatwise/db");
  const pool = db.pool as unknown as { query: unknown; connect: unknown };
  const realQuery = pool.query;
  const realConnect = pool.connect;
  const first = { createdCount: 3, updatedCount: 0, skippedCount: 0, unchangedCount: 0, warnings: [] };
  const sql: string[] = [];
  pool.query = async (text: string) => {
    sql.push(text);
    return { rows: /guest_import_results/.test(text) ? [{ result: first }] : [] };
  };
  pool.connect = async () => {
    throw new Error("no transaction should start for a repeat");
  };
  try {
    const result = await db.commitGuestImport("w1", "First name,Last name\nAnn,Lee\n", { firstName: "First name", lastName: "Last name" }, {}, "u1", false, undefined, "5b0e6b0c-3f0e-4f39-9d0a-5d1d4f0e1a11");
    assert.deepEqual(result, { ...first, repeated: true });
    assert.equal(sql.length, 1);
  } finally {
    pool.query = realQuery;
    pool.connect = realConnect;
  }
  // The key must be a UUID.
  assert.equal(guestImportRequestSchema.safeParse({ csv: "a", mapping: {}, importKey: "nope" }).success, false);
});

test("an import that may have gone in (no answer, a server error) is told apart from a refusal", () => {
  assert.equal(importMayHaveSaved(new ApiError("Couldn't reach Seatwise", NETWORK_ERROR_STATUS)), true);
  assert.equal(importMayHaveSaved(new ApiError("Something went wrong", 500)), true);
  assert.equal(importMayHaveSaved(new ApiError("too busy — nothing was saved", 503)), false);
  assert.equal(importMayHaveSaved(new ApiError("rows have errors", 422)), false);
  assert.equal(importMayHaveSaved(new ApiError("changed", 409)), false);
});

test("the commit's own error rows are shown in the preview", () => {
  const preview: GuestImportPreview = {
    headers: ["First name", "Last name"],
    rows: [
      { rowNumber: 1, kind: "new", preview: { firstName: "Ann", lastName: "Lee" } },
      { rowNumber: 2, kind: "update", guestId: "g2", revision: 1, preview: { firstName: "Bo", lastName: "Ray" } },
    ],
    summary: { newCount: 1, updatingCount: 1, unchangedCount: 0, conflictCount: 0, errorCount: 0, totalRows: 2 },
  };
  const rows = [{ rowNumber: 2, kind: "error" as const, reason: "Side code \"X\" isn't one of BRIDE, GROOM or BOTH", preview: {} }];
  const err = new ApiError("1 row(s) still have errors", 422, undefined, { rows });
  assert.deepEqual(commitErrorRows(err), rows);
  assert.equal(commitErrorRows(new ApiError("x", 409, undefined, { rows })), null);
  const merged = withCommitErrorRows(preview, rows);
  assert.equal(merged.rows[1].kind, "error");
  assert.equal(merged.rows[1].reason, rows[0].reason);
  assert.deepEqual(merged.summary, { newCount: 1, updatingCount: 0, unchangedCount: 0, conflictCount: 0, errorCount: 1, totalRows: 2 });
});

test("a 404 about the item is 'already gone'; one about the wedding isn't", () => {
  assert.equal(isItemGoneError(new ApiError("Vendor not found", 404, undefined, { error: "Vendor not found" })), true);
  assert.equal(isItemGoneError(new ApiError("Wedding not found", 404, undefined, { error: "Wedding not found" })), false);
  assert.equal(isWeddingGone404({ error: "This wedding was deleted — nothing was saved." }), true);
  assert.equal(isItemGoneError(new ApiError("Vendor not found", 409)), false);
});

// --- TS-211: exports ---

test("the generated date and time is MM-DD-YYYY with a 12-hour time, in the viewer's time zone", async () => {
  const { formatGeneratedAt } = await import("./export-data");
  const moment = new Date("2026-10-07T00:05:00Z");
  assert.equal(formatGeneratedAt(moment, "America/New_York"), "Generated 10-06-2026 8:05 PM EDT");
  assert.equal(formatGeneratedAt(moment, "not/a-zone"), "Generated 10-07-2026 12:05 AM UTC");
  assert.equal(formatGeneratedAt(moment, null), "Generated 10-07-2026 12:05 AM UTC");
});

test("the PDFs carry a 'Not seated' section for attending guests without a seat", async () => {
  const { buildSeatingChartPdf, buildLookupListPdf, buildPlaceCardsPdf } = await import("./pdf");
  const { PDFDocument } = await import("pdf-lib");
  const pages = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();
  const unseated = Array.from({ length: 60 }, (_, i) => ({ guestName: `Guest ${i}`, plusOneNames: i === 0 ? "Sam" : null }));
  const extras = { unseated, generatedAt: "Generated 10-07-2026 3:45 PM EDT" };
  const rows = [{ guestName: "Ann Lee", tableLabel: "Table 1" }];
  assert.ok((await pages(await buildLookupListPdf("W", rows, extras))) > (await pages(await buildLookupListPdf("W", rows))));
  const tables = [{ label: "Table 1", guestNames: ["Ann Lee"] }];
  assert.ok((await pages(await buildSeatingChartPdf("W", tables, extras))) > (await pages(await buildSeatingChartPdf("W", tables))));
  // One card page, then the list of guests without a card (60 names run onto a second list page).
  assert.equal(await pages(await buildPlaceCardsPdf(rows, { ...extras, unseated: unseated.slice(0, 3) })), 2);
  assert.equal(await pages(await buildPlaceCardsPdf(rows, extras)), 3);
  assert.equal(await pages(await buildPlaceCardsPdf(rows)), 1);
});

test("a failed export is said in words; the time zone goes with the request; the warning counts guests", () => {
  assert.match(exportErrorMessage(401, { error: "Not authenticated" }, "x"), /signed out/);
  assert.equal(exportErrorMessage(409, { error: "This plan isn't Approved yet" }, "x"), "This plan isn't Approved yet");
  assert.equal(exportErrorMessage(500, null, "Couldn't make that PDF"), "Couldn't make that PDF");
  assert.equal(exportUrl("/api/v1/x", "America/New_York"), "/api/v1/x?tz=America%2FNew_York");
  assert.equal(unseatedExportWarning(0), null);
  assert.match(unseatedExportWarning(1)!, /^1 attending guest isn't seated/);
  assert.match(unseatedExportWarning(3)!, /^3 attending guests aren't seated.*Not seated/);
});
