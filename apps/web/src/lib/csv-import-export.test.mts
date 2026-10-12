// TS-180: unit tests for the guest CSV (formula guard, parser rules, byte-order mark), the side
// names in an export/re-import round trip, and the hidden-character rule for free text. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  toCsv,
  toSpreadsheetSafe,
  fromSpreadsheetSafe,
  CsvParseError,
  CSV_BOM,
  findDuplicateCsvHeader,
  duplicateCsvHeaderMessage,
} from "../../../../packages/shared/src/csv";
import { parseGuestSide, guestSideLabel } from "../../../../packages/shared/src/guest-side";
import { safeText, hasForbiddenControlCharacter } from "../../../../packages/shared/src/safe-text";
import { createGuestSchema } from "../../../../packages/shared/src/schemas/guest";
import { createCommentSchema } from "../../../../packages/shared/src/schemas/collaboration";
import { createVendorSchema } from "../../../../packages/shared/src/schemas/vendor";
import { updateWeddingSchema } from "../../../../packages/shared/src/schemas/wedding";
import { createTimelineEntrySchema } from "../../../../packages/shared/src/schemas/timeline";
import { submitGuestRsvpSchema } from "../../../../packages/shared/src/schemas/rsvp";
import { createTableSchema } from "../../../../packages/shared/src/schemas/table";
import { saveWeddingAsTemplateSchema } from "../../../../packages/shared/src/schemas/template";

// --- Formula guard (item 5) ---

test("a formula at the start of a cell, or after ; a line break or a tab inside it, gets an apostrophe", () => {
  assert.equal(toSpreadsheetSafe("=1+1"), "'=1+1");
  assert.equal(toSpreadsheetSafe("Vegan; =HYPERLINK(\"x\")"), "Vegan; =HYPERLINK(\"x\")", "a space after ; isn't a formula start");
  assert.equal(toSpreadsheetSafe("Vegan;=HYPERLINK(\"x\")"), "Vegan;'=HYPERLINK(\"x\")");
  assert.equal(toSpreadsheetSafe("Line one\n+44 7700"), "Line one\n'+44 7700");
  assert.equal(toSpreadsheetSafe("a\r\n@SUM(A1)"), "a\r\n'@SUM(A1)");
  assert.equal(toSpreadsheetSafe("a\t-1"), "a\t'-1");
  assert.equal(toSpreadsheetSafe("Plain text; nothing odd"), "Plain text; nothing odd");
  assert.equal(toSpreadsheetSafe("O'Brien"), "O'Brien");
});

test("every value survives the guard and back unchanged, apostrophes included", () => {
  const values = [
    "",
    "=1+1",
    "'=1+1",
    "''=1+1",
    "x;'=y",
    "x;=y",
    "a\t\t=b",
    "\t=",
    "'",
    "''",
    "a;'b",
    "Line\n'+1",
    "Vegan; uses a wheelchair",
    "=HYPERLINK(\"https://phish.example\",\"Click\")",
    "-",
    "@",
    "Notes;\n=;\t+",
  ];
  for (const v of values) assert.equal(fromSpreadsheetSafe(toSpreadsheetSafe(v)), v, JSON.stringify(v));
});

test("a cell with ; is quoted, and a whole file round-trips", () => {
  const csv = toCsv(["Name", "Notes"], [["Amy", "Vegan;=1+1"], ["Ben", "Line 1\n-2"], ["Cora", 'Says "hi", twice']]);
  assert.ok(csv.startsWith(CSV_BOM), "starts with a byte-order mark");
  assert.ok(csv.includes(`"Vegan;'=1+1"`), csv);
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed.headers, ["Name", "Notes"]);
  assert.deepEqual(parsed.rows, [
    ["Amy", "Vegan;=1+1"],
    ["Ben", "Line 1\n-2"],
    ["Cora", 'Says "hi", twice'],
  ]);
});

// --- Byte-order mark (item 4) ---

test("a file starting with a byte-order mark reads its first header without it", () => {
  const { headers, rows } = parseCsv(`${CSV_BOM}Guest ID,First name\r\ng1,Amy\r\n`);
  assert.deepEqual(headers, ["Guest ID", "First name"]);
  assert.equal(headers[0].charCodeAt(0), "G".charCodeAt(0));
  assert.deepEqual(rows, [["g1", "Amy"]]);
});

// --- Parser rules (item 9) ---

test("a quote only opens a quoted cell at the start of the cell", () => {
  const { rows } = parseCsv('Name,Notes\nAmy,5" cake\nBen,"quoted, with comma"\n');
  assert.deepEqual(rows, [
    ["Amy", '5" cake'],
    ["Ben", "quoted, with comma"],
  ]);
  // A quote in the middle doesn't swallow the commas and lines after it.
  const { rows: more } = parseCsv('First,Last,Notes\nShaquille,O"Neal,x\nCora,Chen,y\n');
  assert.deepEqual(more, [
    ["Shaquille", 'O"Neal', "x"],
    ["Cora", "Chen", "y"],
  ]);
});

test("a quote that never closes is an error naming the row", () => {
  assert.throws(
    () => parseCsv('Name,Notes\nAmy,fine\nBen,"never closed\nCora,more\n'),
    (err: unknown) => err instanceof CsvParseError && /row 3/.test((err as Error).message)
  );
});

test("two columns with the same name are found (blank headers aside)", () => {
  assert.equal(findDuplicateCsvHeader(["First name", "Last name", "Notes", "Notes"]), "Notes");
  assert.equal(findDuplicateCsvHeader(["First name", "", "Last name", ""]), null);
  assert.equal(findDuplicateCsvHeader(["Notes", "notes"]), null, "names differing in case can still be told apart");
  assert.equal(duplicateCsvHeaderMessage("Notes"), 'Two columns are both called "Notes" — rename one, then choose the file again.');
});

// --- Side names round trip (item 1) ---

test("an export re-imports to the same sides for a wedding whose sides are named Groom / Bride", () => {
  const [label1, label2] = ["Groom", "Bride"];
  const stored = ["BRIDE", "GROOM", "BOTH"] as const;
  const csv = toCsv(["Side"], stored.map((s) => [guestSideLabel(s, label1, label2)]));
  assert.deepEqual(parseCsv(csv).rows, [["Groom"], ["Bride"], ["Both"]]);
  const back = parseCsv(csv).rows.map(([cell]) => parseGuestSide(cell, label1, label2));
  assert.deepEqual(back, stored.map((side) => ({ side })));
});

test("an older export's BRIDE / GROOM still means the stored value, whatever the wedding calls its sides", () => {
  assert.deepEqual(parseGuestSide("GROOM", "Groom", "Bride"), { side: "GROOM" });
  assert.deepEqual(parseGuestSide("BRIDE", "Groom", "Bride"), { side: "BRIDE" });
  assert.deepEqual(parseGuestSide("BOTH", "Groom", "Bride"), { side: "BOTH" });
  // The wedding's names in any other case, then plain bride/groom/both in any case.
  assert.deepEqual(parseGuestSide("groom", "Groom", "Bride"), { side: "BRIDE" });
  assert.deepEqual(parseGuestSide(" alex ", "Alex", "Jordan"), { side: "BRIDE" });
  assert.deepEqual(parseGuestSide("Groom", "Alex", "Jordan"), { side: "GROOM" });
  assert.deepEqual(parseGuestSide("both", "Alex", "Jordan"), { side: "BOTH" });
  // A wedding that names its sides in capitals still re-imports its own export.
  assert.deepEqual(parseGuestSide("GROOM", "GROOM", "BRIDE"), { side: "BRIDE" });
  assert.ok("error" in parseGuestSide("Sam", "Alex", "Jordan"));
});

// --- Hidden control characters (item 13) ---

test("free text refuses NUL and other control characters but keeps line breaks and tabs", () => {
  assert.equal(hasForbiddenControlCharacter("Line one\nLine two\tTabbed"), false);
  assert.equal(hasForbiddenControlCharacter("Windows\r\nline"), false);
  assert.equal(hasForbiddenControlCharacter("nul\u0000here"), true);
  assert.equal(hasForbiddenControlCharacter("bell\u0007"), true);
  assert.equal(hasForbiddenControlCharacter("escape\u001b[31m"), true);
  assert.equal(hasForbiddenControlCharacter("delete\u007f"), true);
  assert.equal(hasForbiddenControlCharacter("lone\rreturn"), true);
  assert.equal(hasForbiddenControlCharacter("Zoë — café ☕"), false);
});

test("safeText trims single-line text, keeps multi-line text, and checks length and blanks", () => {
  assert.equal(safeText(10).parse("  Table 1  "), "Table 1");
  assert.equal(safeText(50, { multiline: true }).parse("  a\r\nb  "), "  a\nb  ");
  assert.equal(safeText(5).safeParse("123456").success, false);
  assert.equal(safeText(5, { required: "Needed" }).safeParse("   ").success, false);
  assert.equal(safeText(5).safeParse("a\u0000").success, false);
});

test("every free-text field refuses a NUL character", () => {
  const nul = "bad\u0000text";
  const guest = { firstName: "Amy", lastName: "Adams" };
  assert.equal(createGuestSchema.safeParse({ ...guest, notes: "Vegan\nno nuts" }).success, true);
  assert.equal(createGuestSchema.safeParse({ ...guest, notes: nul }).success, false);
  assert.equal(createGuestSchema.safeParse({ ...guest, partyName: nul }).success, false);
  assert.equal(createGuestSchema.safeParse({ ...guest, plusOneNames: nul }).success, false);
  assert.equal(createCommentSchema.safeParse({ targetType: "GUEST", guestId: "g", body: nul }).success, false);
  assert.equal(createCommentSchema.safeParse({ targetType: "GUEST", guestId: "g", body: "Fine\nthanks" }).success, true);
  const vendor = { name: "Blooms", category: "FLORIST" };
  assert.equal(createVendorSchema.safeParse(vendor).success, true);
  for (const field of ["name", "contactName", "contactPhone", "contractNotes"]) {
    assert.equal(createVendorSchema.safeParse({ ...vendor, [field]: nul }).success, false, field);
  }
  assert.equal(createVendorSchema.safeParse({ ...vendor, category: "OTHER", categoryOther: nul }).success, false);
  for (const field of ["venueName", "note", "sideLabel1", "sideLabel2"]) {
    assert.equal(updateWeddingSchema.safeParse({ expectedRevision: 0, [field]: nul }).success, false, field);
  }
  assert.equal(createTimelineEntrySchema.safeParse({ time: "16:30", description: nul }).success, false);
  assert.equal(submitGuestRsvpSchema.safeParse({ rsvpStatus: "CONFIRMED", notes: nul }).success, false);
  assert.equal(submitGuestRsvpSchema.safeParse({ rsvpStatus: "CONFIRMED", plusOneNames: nul }).success, false);
  assert.equal(createTableSchema.safeParse({ label: nul, capacity: 8 }).success, false);
  assert.equal(createTableSchema.safeParse({ label: "Head table", capacity: 8, purpose: nul }).success, false);
  assert.equal(saveWeddingAsTemplateSchema.safeParse({ name: nul }).success, false);
});
