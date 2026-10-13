// TS-262: unit tests for names that hide characters ("evil.c" + an invisible mark + "om"), real
// accented names still accepted (also when typed as a letter plus a separate accent mark), import
// name checks that stay fast on a huge cell, and lone windows-1252 names with ’ ("Ja’nae", "Kenya’")
// imported while Mac í and ë are still caught. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { hasHiddenCharacters, looksLikeWebAddress, looksLikePhoneNumber, normalizePersonName, NO_HIDDEN_CHARACTERS_MESSAGE } = await import(
  "../../../../packages/shared/src/validation"
);
const { signupSchema } = await import("../../../../packages/shared/src/schemas/auth");
const { createGuestSchema } = await import("../../../../packages/shared/src/schemas/guest");
const { createWeddingSchema, weddingNameField } = await import("../../../../packages/shared/src/schemas/wedding");
const { emailSafePersonName, emailSafeWeddingName } = await import("../../../../packages/shared/src/email-safe-names");
const { emailSafeNotificationText } = await import("../../../../packages/db/src/queries/notifications");
const { parseCsv } = await import("../../../../packages/shared/src/csv");
const { parseGuestImportRow } = await import("../../../../packages/shared/src/guest-import-row");
const { decodeCsvFile, looksLikeMacRoman, MAC_ENCODING_MESSAGE } = await import("../../../../packages/shared/src/text-decode");
const { prepareImportCsv } = await import("./guest-import-client");

const SIDES = { sideLabel1: "Bride", sideLabel2: "Groom" };
const NAMES = { firstName: "First name", lastName: "Last name" };

// The invisible characters the review found, each put inside "com".
const HIDDEN = ["͏", "️", "︀", "\u{e0100}", "᠋", "᠏", "​", "‌", "‍", "⁠", "﻿", "­", "ㅤ"];

function guestErrors(lastName: string): string[] {
  const r = createGuestSchema.safeParse({ firstName: "Ann", lastName });
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

// --- 1) hidden characters ---------------------------------------------------------------------------

test("TS-262: a name or wedding name with a hidden character is refused with that reason alone", () => {
  for (const h of HIDDEN) {
    const label = h.codePointAt(0)!.toString(16);
    assert.equal(hasHiddenCharacters(`evil.c${h}om`), true, label);
    assert.deepEqual(guestErrors(`evil.c${h}om`), [NO_HIDDEN_CHARACTERS_MESSAGE], label);
    // Not only around a dot: a hidden character anywhere in a name.
    assert.deepEqual(guestErrors(`Le${h}e`), [NO_HIDDEN_CHARACTERS_MESSAGE], label);
    const signup = signupSchema.safeParse({ name: `Visit evil.c${h}om now`, email: "a@b.co", password: "Abcdefgh1234!xyz" });
    assert.equal(signup.success, false, label);
    assert.deepEqual(signup.error!.issues.map((i) => i.message), [NO_HIDDEN_CHARACTERS_MESSAGE], label);
    const wedding = weddingNameField.safeParse(`Verify at seatwise-help.c${h}om`);
    assert.equal(wedding.success, false, label);
    assert.deepEqual(wedding.error!.issues.map((i) => i.message), [NO_HIDDEN_CHARACTERS_MESSAGE], label);
  }
  assert.equal(createWeddingSchema.safeParse({ name: "Ann & Lee", eventDate: "2027-06-01" }).success, true);
  assert.equal(createWeddingSchema.safeParse({ name: "Ann͏ & Lee", eventDate: "2027-06-01" }).success, false);
});

test("TS-262: the web-address and phone checks see through accent marks and hidden characters", () => {
  for (const h of [...HIDDEN, "́", "̣"]) {
    const label = h.codePointAt(0)!.toString(16);
    assert.equal(looksLikeWebAddress(`evil.c${h}om`), true, label);
    assert.equal(looksLikeWebAddress(`evil${h}.com`), true, label);
    assert.equal(looksLikePhoneNumber(`800${h}555${h}1234`), true, label);
  }
  // Real names and titles with accents are not web addresses or phone numbers.
  for (const v of ["José Álvarez", "José Álvarez", "Thị Lan Nguyễn", "Ó Súilleabháin", "J.R. Smith", "St. Clair"]) {
    assert.equal(looksLikeWebAddress(v), false, v);
  }
});

test("TS-262: names saved before the rule are kept out of emails", () => {
  assert.equal(emailSafePersonName("Visit evil.c͏om now"), null);
  assert.equal(emailSafePersonName("Le͏e"), null);
  assert.equal(emailSafeWeddingName("Verify at seatwise-help.c͏om"), null);
  assert.equal(emailSafeWeddingName("Ann & Lee️"), null);
  assert.equal(
    emailSafeNotificationText("Ann evil.c͏om was added to Table 3"),
    "There's an update on a wedding you're part of — open Seatwise to see it."
  );
  // Real accented names, composed or not, still go in.
  assert.equal(emailSafePersonName("José Álvarez"), "José Álvarez");
  assert.equal(emailSafePersonName("José"), "José");
  assert.equal(emailSafeWeddingName("Thị Lan & José's Wedding"), "Thị Lan & José's Wedding");
  assert.equal(emailSafeNotificationText("José Álvarez is coming."), "José Álvarez is coming.");
});

test("TS-262: real accented names are accepted, and one typed as letter + accent mark is saved composed", () => {
  const decomposed = "José"; // "José" as e + a separate accent mark (NFD)
  assert.notEqual(decomposed, "José");
  assert.equal(normalizePersonName(decomposed), "José");
  const guest = createGuestSchema.parse({ firstName: decomposed, lastName: "Álvarez" });
  assert.equal(guest.firstName, "José");
  assert.equal(guest.lastName, "Álvarez");
  assert.equal(signupSchema.parse({ name: "Thị Lan Nguyễn", email: "a@b.co", password: "Abcdefgh1234!xyz" }).name, "Thị Lan Nguyễn");
  assert.equal(weddingNameField.parse("José & Zoë"), "José & Zoë");
  for (const name of ["Thị Lan Nguyễn", "Ó Súilleabháin", "José", "Zoë", "François", "Ngọc", "Ærøskøbing", "Dvořák", "Łukasz"]) {
    assert.deepEqual(guestErrors(name), [], name);
    assert.deepEqual(guestErrors(name.normalize("NFD")), [], `${name} (NFD)`);
  }
});

test("TS-262: every name in the sample import file is accepted", () => {
  const csv = readFileSync(fileURLToPath(new URL("../../../../docs/sample-guest-import.csv", import.meta.url)), "utf8");
  const { headers, rows } = parseCsv(csv.replace(/^﻿/, ""));
  const first = headers.indexOf("First Name");
  const last = headers.indexOf("Last Name");
  assert.ok(rows.length >= 20);
  for (const row of rows) {
    for (const name of [row[first], row[last]]) {
      assert.equal(hasHiddenCharacters(name), false, name);
      assert.deepEqual(guestErrors(name), [], name);
      assert.deepEqual(guestErrors(name.normalize("NFD")), [], `${name} (NFD)`);
    }
  }
});

test("TS-262: an import name cell with a hidden character is refused with that reason; an NFD name is saved composed", () => {
  const headers = ["First name", "Last name"];
  const hidden = parseGuestImportRow(["Ann", "evil.c͏om"], headers, NAMES, SIDES);
  assert.equal(hidden.errors.length, 1);
  assert.match(hidden.errors[0], /can't contain hidden characters/);
  const nfd = parseGuestImportRow(["José", "Nguyễn"], headers, NAMES, SIDES);
  assert.deepEqual(nfd.errors, []);
  assert.equal(nfd.data.firstName, "José");
  assert.equal(nfd.data.lastName, "Nguyễn");
});

// --- 2) import name checks stay fast ----------------------------------------------------------------

function windows1252(text: string): Uint8Array {
  const decoder = new TextDecoder("windows-1252");
  const byChar = new Map<string, number>();
  for (let b = 0; b < 256; b++) byChar.set(decoder.decode(new Uint8Array([b])), b);
  return new Uint8Array([...text].map((ch) => byChar.get(ch)!));
}
function macRoman(text: string): Uint8Array {
  const decoder = new TextDecoder("macintosh");
  const byChar = new Map<string, number>();
  for (let b = 0; b < 256; b++) byChar.set(decoder.decode(new Uint8Array([b])), b);
  return new Uint8Array([...text].map((ch) => byChar.get(ch)!));
}

test("TS-262: a huge name cell is checked for the Mac format quickly (was 3.7 s for 20,000 characters)", () => {
  // Generous bounds so a slow machine doesn't fail it; the old check took many seconds on these.
  for (const cell of ["‘" + "a".repeat(50_000) + "X", "‘" + "a b".repeat(17_000) + "X", "“" + "a.b-c ".repeat(8_000) + "x", "‘" + "ab‘ ".repeat(12_500)]) {
    const t = performance.now();
    looksLikeMacRoman(cell, true, true, false);
    assert.ok(performance.now() - t < 1000, `${cell.length} characters took ${performance.now() - t} ms`);
  }
  // A whole 300 KB file built the same way.
  const bytes = Buffer.concat([Buffer.from("First name,Last name\r\nAnn,"), Buffer.from([0x91]), Buffer.alloc(300_000, 0x61), Buffer.from("X\r\n")]);
  const t = performance.now();
  const { text, encoding } = decodeCsvFile(bytes);
  prepareImportCsv(text, encoding, NAMES);
  assert.ok(performance.now() - t < 2000, `300 KB file took ${performance.now() - t} ms`);
});

// --- 3) lone windows-1252 names with ’ --------------------------------------------------------------

function importOne(bytes: Uint8Array): "refused" | { firstName: string; lastName: string } {
  const { text, encoding } = decodeCsvFile(bytes);
  const prepared = prepareImportCsv(text, encoding, NAMES);
  if ("error" in prepared) {
    assert.ok(prepared.error.startsWith(MAC_ENCODING_MESSAGE), prepared.error);
    return "refused";
  }
  const { headers, rows } = parseCsv(prepared.csv);
  const row = parseGuestImportRow(rows[0], headers, NAMES, SIDES);
  assert.deepEqual(row.errors, []);
  return { firstName: row.data.firstName!, lastName: row.data.lastName! };
}

test("TS-262: a lone windows-1252 Ja’nae, Da’shawn, Ta’kia, Kenya’, Andre’ or Rene’ is imported", () => {
  for (const name of ["Ja’nae", "Da’shawn", "Ta’kia", "Kenya’", "Andre’", "Rene’", "Ka’iulani"]) {
    assert.equal(looksLikeMacRoman(name, true, true, false), false, name);
    assert.deepEqual(importOne(windows1252(`First name,Last name\r\n${name},Lee\r\n`)), { firstName: name.replace("’", "'"), lastName: "Lee" }, name);
  }
});

test("TS-262: Mac í after a consonant, Mac í in Luís, and Mac ë at a word's end are still refused", () => {
  // As read from a Mac file (í is ’ and ë is ‘ in windows-1252).
  for (const name of ["Mar’a", "Garc’a", "Mart’nez", "Rodr’guez", "Mart’", "Lev’", "Lu’s", "Lu’sa", "Zo‘", "Chlo‘", "Zo‘ Ann", "Bront‘"]) {
    assert.equal(looksLikeMacRoman(name, true, true, false), true, name);
  }
  // From real Mac Roman bytes.
  for (const [first, last] of [
    ["María", "Lee"],
    ["Ana", "García"],
    ["Ana", "Martínez"],
    ["Martí", "Smith"],
    ["Leví", "Smith"],
    ["Luís", "Smith"],
    ["Zoë", "Smith"],
    ["Ana", "Brontë"],
  ]) {
    assert.equal(importOne(macRoman(`First name,Last name\r\n${first},${last}\r\n`)), "refused", `${first} ${last}`);
  }
  // Quoted nicknames are still not the Mac sign.
  assert.equal(looksLikeMacRoman("Robert ‘Bob’", true), false);
  assert.equal(looksLikeMacRoman("Robert ‘Bobby Joe’", true), false);
  assert.equal(looksLikeMacRoman("Robert ‘Bobby-Joe’", true), false);
});

test("TS-262: a lone windows-1252 Shan’tel (n before ’) is still refused -- it looks exactly like Mac Ben’tez (Benítez)", () => {
  assert.equal(looksLikeMacRoman("Shan’tel", true, true, false), true);
  assert.equal(looksLikeMacRoman("Ben’tez", true, true, false), true);
  // With any other Windows sign in the file it imports.
  assert.equal(looksLikeMacRoman("Shan’tel", true, true, true), false);
});
