// TS-198: unit tests for guest import handling real-world files and keeping the rules -- UTF-16
// and old Mac files, the "couldn't read this character" mark (U+FFFD), a stored value that looks
// like the CLEAR token, old values that today's rules would refuse, and the smaller fixes (phone
// box, blank comments, plus-ones on printouts, shortened table names). Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCsvBytes,
  decodeCsvFile,
  findMacRomanCell,
  looksLikeMacRoman,
  MAC_ENCODING_MESSAGE,
} from "../../../../packages/shared/src/text-decode";
import { parseCsv, toCsv } from "../../../../packages/shared/src/csv";
import { parseGuestImportRow } from "../../../../packages/shared/src/guest-import-row";
import { changedImportFields, type GuestImportCurrentValues } from "../../../../packages/shared/src/guest-import-compare";
import { safeText } from "../../../../packages/shared/src/safe-text";
import { submitGuestRsvpSchema } from "../../../../packages/shared/src/schemas/rsvp";
import { createCommentSchema } from "../../../../packages/shared/src/schemas/collaboration";
import {
  CONTACT_PHONE_HTML_PATTERN,
  cutToLimit,
} from "../../../../packages/shared/src/field-limits";
import { createVendorSchema } from "../../../../packages/shared/src/schemas/vendor";
import { plusOnesToPrint } from "../../../../packages/shared/src/guest-counts";

const SIDES = { sideLabel1: "Bride", sideLabel2: "Groom" };

// --- Reading the file (item 3) ---

const CSV = "First name,Last name\r\nRenée,Müller\r\n";

test("a UTF-16 file with a byte-order mark reads correctly, little- and big-endian", () => {
  const le = new Uint8Array([0xff, 0xfe, ...Buffer.from(CSV, "utf16le")]);
  assert.deepEqual(parseCsv(decodeCsvBytes(le)).rows, [["Renée", "Müller"]]);
  assert.deepEqual(parseCsv(decodeCsvBytes(le)).headers, ["First name", "Last name"]);
  // Big-endian: every pair of bytes swapped.
  const swapped = Buffer.from(CSV, "utf16le");
  for (let i = 0; i < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
  const be = new Uint8Array([0xfe, 0xff, ...swapped]);
  assert.deepEqual(parseCsv(decodeCsvBytes(be)).rows, [["Renée", "Müller"]]);
  assert.deepEqual(parseCsv(decodeCsvBytes(be.buffer.slice(0) as ArrayBuffer)).headers, ["First name", "Last name"]);
});

test("a file in the older Mac encoding is found in its imported cells", () => {
  // Mac Roman: é is the byte 8E and ü is 9F -- read as windows-1252 they'd be "RenŽe" and "MŸller".
  // TS-210: decoding no longer refuses the file -- the check runs on the cells the import uses.
  const macRoman = new Uint8Array([
    ...Buffer.from("First name,Last name\r\nRen", "ascii"),
    0x8e,
    ...Buffer.from("e,M", "ascii"),
    0x9f,
    ...Buffer.from("ller\r\n", "ascii"),
  ]);
  const { text, encoding } = decodeCsvFile(macRoman);
  assert.equal(encoding, "windows-1252");
  const { rows } = parseCsv(text);
  assert.deepEqual(findMacRomanCell(rows, [0, 1], [0, 1]), { rowNumber: 1, column: 0 });
  assert.match(MAC_ENCODING_MESSAGE, /CSV UTF-8/);
  // "José" (é at the end of the word).
  assert.equal(looksLikeMacRoman("JosŽ"), true);
});

test("real windows-1252 text is still read, not mistaken for the Mac encoding", () => {
  // O’Brien (curly apostrophe, 92), Œuvre (8C at the start of a word), cœur (9C), “quoted” (93/94),
  // and a dash between words (96 with spaces).
  const bytes = new Uint8Array([
    ...Buffer.from("O", "ascii"), 0x92, ...Buffer.from("Brien,", "ascii"),
    0x8c, ...Buffer.from("uvre,c", "ascii"), 0x9c, ...Buffer.from("ur,", "ascii"),
    0x93, ...Buffer.from("x", "ascii"), 0x94, ...Buffer.from(",a ", "ascii"), 0x96, ...Buffer.from(" b", "ascii"),
  ]);
  assert.equal(decodeCsvBytes(bytes), "O’Brien,Œuvre,cœur,“x”,a – b");
  assert.equal(decodeCsvBytes(new Uint8Array([...Buffer.from("M", "ascii"), 0xfc, ...Buffer.from("ller", "ascii")])), "Müller");
});

// --- Import rows: values the guest already has (items 2, 4 and 5) ---

const HEADERS = ["Guest ID", "First name", "Last name", "Party / household", "Notes", "Plus-ones", "Guest's RSVP note"];
const MAPPING = {
  guestId: "Guest ID",
  firstName: "First name",
  lastName: "Last name",
  partyName: "Party / household",
  notes: "Notes",
  plusOneNames: "Plus-ones",
};

function guest(overrides: Partial<GuestImportCurrentValues> = {}): GuestImportCurrentValues {
  return {
    firstName: "Ann",
    lastName: "Lee",
    partyName: null,
    headcount: 1,
    tier: "OTHER",
    rsvpStatus: "PENDING",
    requiresAccessibleTable: false,
    dayOfAttendance: "ATTENDING",
    side: "BOTH",
    ageCategory: "ADULT",
    notes: null,
    plusOneNames: null,
    ...overrides,
  };
}

/** Exports one guest the way the export route does, reads the file back, and parses its row. */
function roundTrip(g: GuestImportCurrentValues, rsvpNote = "", withCurrent = true) {
  const csv = toCsv(HEADERS, [["g1", g.firstName, g.lastName, g.partyName ?? "", g.notes ?? "", g.plusOneNames ?? "", rsvpNote]]);
  const parsed = parseCsv(csv);
  return parseGuestImportRow(parsed.rows[0], parsed.headers, MAPPING, SIDES, withCurrent ? g : undefined);
}

test("a stored value that looks like the clear token survives an export and re-import", () => {
  for (const g of [
    guest({ partyName: "CLEAR" }),
    guest({ notes: "[clear]" }),
    guest({ plusOneNames: "[Clear]" }),
    guest({ partyName: "CLEAR", notes: "CLEAR", plusOneNames: "[CLEAR]" }),
  ]) {
    const { errors, data } = roundTrip(g);
    assert.deepEqual(errors, []);
    assert.deepEqual(changedImportFields(data, g), {}, JSON.stringify(g));
  }
  // A cell that says CLEAR over a different value still clears it.
  const g = guest({ partyName: "The Lees" });
  const parsed = parseCsv(toCsv(HEADERS, [["g1", "Ann", "Lee", "CLEAR", "", "", ""]]));
  const { data } = parseGuestImportRow(parsed.rows[0], parsed.headers, MAPPING, SIDES, g);
  assert.deepEqual(changedImportFields(data, g), { partyName: null });
});

test("the U+FFFD mark is refused only in an imported cell that says something new", () => {
  // A guest's own RSVP note (never imported) with the mark doesn't stop the row.
  const plain = guest();
  assert.deepEqual(roundTrip(plain, "see you �").errors, []);
  // A note the guest already has with the mark comes back unchanged.
  const marked = guest({ notes: "Allergic to nuts �" });
  const kept = roundTrip(marked);
  assert.deepEqual(kept.errors, []);
  assert.deepEqual(kept.keptAsIs, ["firstName", "lastName", "notes"]);
  assert.deepEqual(changedImportFields(kept.data, marked), {});
  // A new value holding the mark is refused, saying why -- and so is a new guest's.
  const parsed = parseCsv(toCsv(HEADERS, [["g1", "Ann", "Lee", "", "Changed �", "", ""]]));
  const changed = parseGuestImportRow(parsed.rows[0], parsed.headers, MAPPING, SIDES, marked);
  assert.equal(changed.errors.length, 1);
  assert.match(changed.errors[0], /^Notes has characters that couldn't be read .* 'CSV UTF-8'/);
  assert.equal(roundTrip(marked, "", false).errors.length, 1);
  const name = parseCsv(toCsv(HEADERS, [["", "Ann", "M�ller", "", "", "", ""]]));
  assert.match(parseGuestImportRow(name.rows[0], name.headers, MAPPING, SIDES).errors[0], /^Last name "M�ller" has characters that couldn't be read/);
});

test("a value saved before today's rules comes back unchanged instead of blocking the row", () => {
  // A name mixing alphabets (Cyrillic А) and a household with a line break -- both refused for new
  // values today, both possible in older data.
  const old = guest({ firstName: "Аnn", partyName: "The Lees\nWest" });
  const { errors, data, keptAsIs } = roundTrip(old);
  assert.deepEqual(errors, []);
  assert.deepEqual(keptAsIs, ["firstName", "lastName", "partyName"]);
  assert.deepEqual(changedImportFields(data, old), {});
  // The same values for a new guest are still refused.
  assert.equal(roundTrip(old, "", false).errors.length, 2);
});

// --- Free text still accepts the mark: a guest whose saved note already has one must be able to
// send their RSVP again (only the import refuses it, in a new value, where letters were just lost) ---

test("free text accepts the U+FFFD mark, so old saved text can be sent back", () => {
  assert.equal(safeText(50).parse("M\uFFFDller"), "M\uFFFDller");
  assert.equal(submitGuestRsvpSchema.safeParse({ rsvpStatus: "CONFIRMED", notes: "see you \uFFFD" }).success, true);
  assert.equal(safeText(50).parse("Müller"), "Müller");
});

// --- Smaller fixes (item 6) ---

test("the phone box accepts spaces after the number, as the server does", () => {
  const html = new RegExp(`^(?:${CONTACT_PHONE_HTML_PATTERN})$`, "v");
  for (const phone of ["555-0199 ", "317 555 0199 ext. 12 ", "555-0199x4\t", " 555-0199  "]) {
    assert.equal(html.test(phone), true, JSON.stringify(phone));
    assert.equal(createVendorSchema.safeParse({ name: "Florist", category: "FLORIST", contactPhone: phone }).success, true, JSON.stringify(phone));
  }
  for (const phone of ["555-0199 x", "call 555 "]) {
    assert.equal(html.test(phone), false, JSON.stringify(phone));
    assert.equal(createVendorSchema.safeParse({ name: "Florist", category: "FLORIST", contactPhone: phone }).success, false, JSON.stringify(phone));
  }
});

test("a comment of only spaces and line breaks is refused as empty", () => {
  for (const body of ["   ", "\n\n", " \r\n\t "]) {
    const r = createCommentSchema.safeParse({ targetType: "GUEST", guestId: "g1", body });
    assert.equal(r.success, false, JSON.stringify(body));
    assert.equal(!r.success && r.error.issues.some((i) => i.message === "Comment can't be empty"), true);
  }
  assert.equal(createCommentSchema.parse({ targetType: "GUEST", guestId: "g1", body: "  hi\n" }).body, "  hi\n");
});

test("plus-ones are printed only for a party bigger than one", () => {
  assert.equal(plusOnesToPrint({ headcount: 2, plusOneNames: "Sam" }), "Sam");
  assert.equal(plusOnesToPrint({ headcount: 1, plusOneNames: "Sam" }), null);
  assert.equal(plusOnesToPrint({ headcount: 3, plusOneNames: null }), null);
  assert.equal(plusOnesToPrint({ headcount: 3, plusOneNames: "  " }), null);
});

test("a shortened table name is cut between whole characters", () => {
  // 95 letters then an emoji (two UTF-16 units): cutting at 96 would split the emoji.
  const label = `${"a".repeat(95)}🎉🎉`;
  assert.equal(cutToLimit(label, 96), "a".repeat(95));
  assert.equal(cutToLimit(label, 97), `${"a".repeat(95)}🎉`);
  assert.equal(cutToLimit("Table 1", 100), "Table 1");
  for (let max = 0; max < label.length; max++) {
    const cut = cutToLimit(label, max);
    assert.ok(cut.length <= max);
    assert.ok(!/[\uD800-\uDBFF]$/.test(cut), `max ${max}`);
  }
});
