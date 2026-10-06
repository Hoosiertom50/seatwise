// TS-190: unit tests for guest import and export keeping data right -- reading Excel's older
// Windows encoding, side names that can't be told apart, the export's name order, the free-text
// rules, and telling an import row that changes nothing. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCsvBytes,
  hasUnreadableCharacters,
  UNREADABLE_CHARACTERS_MESSAGE,
} from "../../../../packages/shared/src/text-decode";
import { parseCsv } from "../../../../packages/shared/src/csv";
import {
  createWeddingSchema,
  updateWeddingSchema,
  sideLabelsClash,
  SIDE_LABELS_MESSAGE,
} from "../../../../packages/shared/src/schemas/wedding";
import {
  safeText,
  hasForbiddenControlCharacter,
  LINE_BREAK_MESSAGE,
} from "../../../../packages/shared/src/safe-text";
import {
  changedImportFields,
  importRowChangesNothing,
  type GuestImportCurrentValues,
} from "../../../../packages/shared/src/guest-import-compare";
import { compareGuestNames } from "./guest-name-order";

// --- Reading the file (item 3) ---

test("a windows-1252 file (Excel's plain 'CSV' on Windows) reads Müller correctly", () => {
  // "First name,Last name\r\nAnna,Müller\r\n" with ü as the single byte 0xFC.
  const bytes = new Uint8Array([
    ...Buffer.from("First name,Last name\r\nAnna,M", "ascii"),
    0xfc,
    ...Buffer.from("ller\r\n", "ascii"),
  ]);
  const text = decodeCsvBytes(bytes);
  assert.equal(hasUnreadableCharacters(text), false);
  assert.deepEqual(parseCsv(text).rows, [["Anna", "Müller"]]);
  // The euro sign and curly quotes live in the 0x80-0x9F range in windows-1252.
  assert.equal(decodeCsvBytes(new Uint8Array([0x80, 0x93, 0x94])), "€“”");
});

test("a UTF-8 file reads as UTF-8 (byte-order mark or not), from an ArrayBuffer too", () => {
  const utf8 = new TextEncoder().encode("Last name\nMüller Zoë 王\n");
  assert.equal(decodeCsvBytes(utf8), "Last name\nMüller Zoë 王\n");
  assert.equal(decodeCsvBytes(utf8.buffer.slice(0) as ArrayBuffer), "Last name\nMüller Zoë 王\n");
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  assert.deepEqual(parseCsv(decodeCsvBytes(withBom)).headers, ["Last name"]);
});

test("text that already lost its letters (U+FFFD) is caught, with a clear message", () => {
  assert.equal(hasUnreadableCharacters("M�ller"), true);
  assert.equal(hasUnreadableCharacters("Müller"), false);
  assert.match(UNREADABLE_CHARACTERS_MESSAGE, /CSV UTF-8/);
});

// --- Side names (item 2) ---

test("side names equal to 'Both' or to each other (any case) are refused, creating and updating", () => {
  const base = { name: "Our wedding" };
  const failsWith = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
    !r.success && r.error!.issues.some((i) => i.message === SIDE_LABELS_MESSAGE);
  assert.equal(failsWith(createWeddingSchema.safeParse({ ...base, sideLabel1: "Both" })), true);
  assert.equal(failsWith(createWeddingSchema.safeParse({ ...base, sideLabel2: " BOTH " })), true);
  assert.equal(failsWith(createWeddingSchema.safeParse({ ...base, sideLabel1: "Alex", sideLabel2: "alex" })), true);
  assert.equal(createWeddingSchema.safeParse({ ...base, sideLabel1: "Alex", sideLabel2: "Jordan" }).success, true);
  // The defaults (Bride / Groom) are fine.
  assert.equal(createWeddingSchema.safeParse(base).success, true);
  assert.equal(failsWith(updateWeddingSchema.safeParse({ sideLabel1: "both" })), true);
  assert.equal(failsWith(updateWeddingSchema.safeParse({ sideLabel1: "Sam", sideLabel2: "SAM" })), true);
  assert.equal(updateWeddingSchema.safeParse({ sideLabel1: "Sam" }).success, true);
  assert.equal(updateWeddingSchema.safeParse({ venueName: "The Barn" }).success, true);
  // The route checks one name against the other, stored one.
  assert.equal(sideLabelsClash("Groom", "groom"), true);
  assert.equal(sideLabelsClash("Bothwell", "Groom"), false);
  assert.equal(sideLabelsClash("Bride", "Groom"), false);
});

// --- The export's order (item 5) ---

test("guests are ordered by last name, then first name, compared in two steps", () => {
  const guests = [
    { firstName: "Amy", lastName: "Leez" },
    { firstName: "Zed", lastName: "Lee" },
    { firstName: "Bob", lastName: "Lee" },
  ];
  const ordered = [...guests].sort(compareGuestNames).map((g) => `${g.lastName} ${g.firstName}`);
  assert.deepEqual(ordered, ["Lee Bob", "Lee Zed", "Leez Amy"]);
});

// --- Free text (item 7) ---

test("a multi-line value's length is counted after Windows line endings become plain ones", () => {
  const tenLines = Array.from({ length: 10 }, () => "a").join("\r\n"); // 28 characters, 19 once saved
  assert.equal(tenLines.length, 28);
  assert.equal(safeText(19, { multiline: true }).parse(tenLines), Array.from({ length: 10 }, () => "a").join("\n"));
  assert.equal(safeText(18, { multiline: true }).safeParse(tenLines).success, false);
});

test("a single-line value can't hold a line break", () => {
  for (const value of ["Table\n1", "Table\r\n1", "Table\r1"]) {
    assert.equal(safeText(50).safeParse(value).success, false, JSON.stringify(value));
  }
  const r = safeText(50).safeParse("Table\n1");
  assert.equal(!r.success && r.error.issues.some((i) => i.message === LINE_BREAK_MESSAGE), true);
  // Leading and trailing line breaks are trimmed away like spaces.
  assert.equal(safeText(50).parse("\nTable 1\n"), "Table 1");
  assert.equal(safeText(50, { multiline: true }).parse("Line one\nLine two"), "Line one\nLine two");
});

test("C1 control characters and text-direction marks are refused; accents and emoji are fine", () => {
  for (const ch of ["\u0080", "\u0085", "\u009f", "‪", "‮", "⁦", "⁩"]) {
    assert.equal(hasForbiddenControlCharacter(`Amy${ch}Adams`), true, ch.codePointAt(0)!.toString(16));
    assert.equal(safeText(50).safeParse(`Amy${ch}Adams`).success, false);
  }
  for (const ok of ["Zoë Müller", "José Ñúñez", "Party 🎉🥂", "👩‍👩‍👧 family", "שלום", "مرحبا", "王小明", "Ça va — “yes”"]) {
    assert.equal(hasForbiddenControlCharacter(ok), false, ok);
    assert.equal(safeText(50).parse(ok), ok);
  }
});

// --- Import rows that change nothing (item 4) ---

const current: GuestImportCurrentValues = {
  firstName: "Amy",
  lastName: "Adams",
  partyName: "The Adams Family",
  headcount: 2,
  tier: "VIP",
  rsvpStatus: "CONFIRMED",
  requiresAccessibleTable: false,
  dayOfAttendance: "ATTENDING",
  side: "BRIDE",
  ageCategory: "ADULT",
  notes: "Vegan\nno nuts",
  plusOneNames: null,
};

test("an import row equal to the guest changes nothing", () => {
  const row = {
    firstName: "Amy",
    lastName: "Adams",
    partyName: "The Adams Family",
    headcount: 2,
    tier: "VIP",
    rsvpStatus: "CONFIRMED",
    requiresAccessibleTable: false,
    dayOfAttendance: "ATTENDING",
    side: "BRIDE",
    ageCategory: "ADULT",
    notes: "Vegan\nno nuts",
  };
  assert.equal(importRowChangesNothing(row, current), true);
  assert.deepEqual(changedImportFields(row, current), {});
  // Clearing a value that is already empty changes nothing either.
  assert.equal(importRowChangesNothing({ firstName: "Amy", lastName: "Adams", plusOneNames: null }, current), true);
});

test("only the values that differ are kept", () => {
  assert.deepEqual(
    changedImportFields({ firstName: "Amy", lastName: "Adams", rsvpStatus: "DECLINED", notes: "Vegan" }, current),
    { rsvpStatus: "DECLINED", notes: "Vegan" }
  );
  assert.deepEqual(changedImportFields({ firstName: "Amy", lastName: "Adams", partyName: null }, current), {
    partyName: null,
  });
  assert.deepEqual(changedImportFields({ firstName: "Amy", lastName: "Adams", ageCategory: "CHILD" }, current), {
    ageCategory: "CHILD",
  });
  assert.equal(importRowChangesNothing({ firstName: "Amie", lastName: "Adams" }, current), false);
});
