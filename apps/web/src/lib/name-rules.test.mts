// TS-156: unit tests for the rule that names going into emails can't read as a web address.
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMixedScriptWord, looksLikePhoneNumber, looksLikeWebAddress } from "../../../../packages/shared/src/validation";
import { signupSchema, resetPasswordSchema } from "../../../../packages/shared/src/schemas/auth";
import { createGuestSchema } from "../../../../packages/shared/src/schemas/guest";
import { createWeddingSchema, updateWeddingSchema, weddingNameField } from "../../../../packages/shared/src/schemas/wedding";
import { duplicateWeddingSchema } from "../../../../packages/shared/src/schemas/template";
import { parseCsv } from "../../../../packages/shared/src/csv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("domain-looking text is caught", () => {
  for (const v of ["evil.com", "Verify at evil.example", "seatwise.support now", "WWW.EVIL.CO", "go to bit.ly"]) {
    assert.equal(looksLikeWebAddress(v), true, v);
  }
});

test("real names and wedding titles with initials or abbreviations pass", () => {
  for (const v of ["J.R. Smith", "St. Clair", "Mary-Kate O'Neil Jr.", "Smith-Jones Wedding, Est. 2026", "A. B. Chen", "José Álvarez"]) {
    assert.equal(looksLikeWebAddress(v), false, v);
  }
});

test("signup refuses web-address names, line breaks and symbols, and trims", () => {
  const base = { email: "a@example.invalid", password: "long-enough-pw" };
  assert.equal(signupSchema.safeParse({ ...base, name: "Verify at evil.example" }).success, false);
  assert.equal(signupSchema.safeParse({ ...base, name: "Tom\nClick here" }).success, false);
  assert.equal(signupSchema.safeParse({ ...base, name: "https://x" }).success, false);
  const ok = signupSchema.safeParse({ ...base, name: "  Tom Carter  " });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.name, "Tom Carter");
});

// TS-163: a guest's name goes into their RSVP email too.
test("a guest's first or last name can't read as a web address", () => {
  const base = { firstName: "Ana", lastName: "Ruiz" };
  assert.equal(createGuestSchema.safeParse(base).success, true);
  assert.equal(createGuestSchema.safeParse({ ...base, firstName: "Claim your prize at evilsite.com" }).success, false);
  assert.equal(createGuestSchema.safeParse({ ...base, lastName: "www.example.org" }).success, false);
  assert.equal(createGuestSchema.safeParse({ ...base, firstName: "J. R." }).success, true);
});

// TS-163: bcrypt only reads a password's first 72 bytes.
test("new passwords are capped at 72 bytes, counting multi-byte letters", () => {
  const signup = (password: string) => signupSchema.safeParse({ name: "Ana Ruiz", email: "ana@example.invalid", password }).success;
  assert.equal(signup("a".repeat(72)), true);
  assert.equal(signup("a".repeat(73)), false);
  assert.equal(signup("é".repeat(36)), true); // 72 bytes
  assert.equal(signup("é".repeat(37)), false); // 74 bytes
  assert.equal(resetPasswordSchema.safeParse({ token: "a".repeat(64), password: "b".repeat(73) }).success, false);
});

// TS-171: a wedding's name can't carry a phone number.
test("wedding names with 7 or more digits in a row (ignoring spaces, hyphens, periods and commas) are refused", () => {
  const name = (v: string) => updateWeddingSchema.safeParse({ expectedRevision: 0, name: v });
  for (const v of [
    "Your account is suspended. Call 1 800 555 0199 now!",
    "Call 800-555-0199",
    "Ring 1.800.555.0199",
    "Ana 1234567",
    "Bo ١٢٣٤٥٦٧",
  ]) {
    const result = name(v);
    assert.equal(result.success, false, v);
    assert.match(JSON.stringify(result.error?.flatten().fieldErrors), /phone number/, v);
  }
  for (const v of ["Ana & Bo 2026", "Smith-Jones Wedding, Est. 2026", "Party of 12 on 10-5-26", "Room 101 & 102"]) {
    assert.equal(name(v).success, true, v);
  }
  // The same rule wherever a wedding is named.
  assert.equal(createWeddingSchema.safeParse({ name: "Call 555 0199 12" }).success, false);
  assert.equal(duplicateWeddingSchema.safeParse({ name: "Call 555 0199 12" }).success, false);
});

test("emails only use names that pass today's rules, otherwise something neutral", async () => {
  const { emailSafePersonName, emailSafeWeddingName } = await import("./email-safe-names");
  assert.equal(emailSafePersonName(" Ana "), "Ana");
  assert.equal(emailSafePersonName("visit evilsite.com"), null);
  assert.equal(emailSafePersonName("<b>x</b>"), null);
  assert.equal(emailSafeWeddingName("Ana & Bo's Wedding"), "Ana & Bo's Wedding");
  assert.equal(emailSafeWeddingName("Free gift at evilsite.com"), null);
  // TS-171: a name saved before the phone-number rule isn't put into an email either.
  assert.equal(emailSafeWeddingName("Call 1 800 555 0199 now!"), null);
});

// TS-178: the web-address check catches hyphenated and one-letter names and spaces around the dot,
// while real names with initials and titles still pass.
test("more ways of writing a web address are caught", () => {
  for (const v of [
    "seatwise-help-a.com",
    "x.com",
    "evil. com",
    "evil .com",
    "evil . com",
    "Evil . COM",
    "evil dot com",
    "a.co",
    "help-desk.net",
    "O'Neil.com",
    "Ana & Bo at x.io",
    "visit x . org today",
    "pay-here.shop",
    `x${String.fromCodePoint(0x3002)}com`,
    "j.ly",
  ]) {
    assert.equal(looksLikeWebAddress(v), true, v);
  }
});

test("real names and wedding titles still pass the web-address check", () => {
  for (const v of [
    "J. R. Smith",
    "J.R. Smith",
    "J.R.R. Tolkien",
    "St. Clair",
    "Anne-Marie St. James",
    "Ana & Bo 2027",
    "Mary-Jane O'Neil",
    "Mary-Kate O'Neil Jr.",
    "Ana B. De Souza",
    "Dr. Who",
    "Mr. & Mrs. Smith",
    "J. Link",
    "Bo. Coleman",
    "Ana B. Orgel",
    "Ana Comfort",
    "Ana B. Netherton",
    "Smith & Co. Wedding",
    "Smith-Jones Wedding, Est. 2026",
    "Jean-Luc Picard",
    "D'Angelo",
    "José Álvarez",
    "Li Na",
    "Ms. Io",
    "J. Co",
  ]) {
    assert.equal(looksLikeWebAddress(v), false, v);
  }
});

test("phone numbers are caught whatever separates the digits; years, dates and room numbers aren't", () => {
  const dash = String.fromCodePoint(0x2013);
  for (const v of [
    "800, 555, 1234",
    "800,555,1234",
    "800 / 555 / 1234",
    "(800) 555-1234",
    "800'555'1234",
    "800_555_1234",
    `800${dash}555${dash}1234`,
    "[800] 555 1234",
    "Ana 1234567",
  ]) {
    assert.equal(looksLikePhoneNumber(v), true, v);
  }
  for (const v of ["Ana & Bo 2026", "Room 101 & 102", "Est. 2026", "10-5-26", "Party of 12 on 10-5-26", "Ana & Bo, 2026, Table 12"]) {
    assert.equal(looksLikePhoneNumber(v), false, v);
  }
  assert.equal(updateWeddingSchema.safeParse({ expectedRevision: 0, name: "Call 800, 555, 1234" }).success, false);
});

// Look-alike letters, written by code point so they can be seen in the source: Cyrillic а (0x430),
// е (0x435), у (0x443), Ј (0x408); Greek Α (0x391), ο (0x3BF).
const cyr = (cp: number) => String.fromCodePoint(cp);

test("a word mixing Latin letters with Cyrillic or Greek look-alikes is refused in person and wedding names", async () => {
  for (const v of [`P${cyr(0x430)}ypal`, `Smith-${cyr(0x408)}ones`, `${cyr(0x391)}nna`, `B${cyr(0x3bf)}b Smith`, `Ana O'N${cyr(0x435)}il`]) {
    assert.equal(hasMixedScriptWord(v), true, v);
  }
  // Names written in one alphabet, or with separate words in different ones, are fine.
  for (const v of ["Иван Петров", "Ivanova-Иванова", "Νίκος Παπαδόπουλος", "Ana Βασιλείου", "José", "Zoë Brontë", "Mary-Jane O'Neil", "Nguyễn Văn An"]) {
    assert.equal(hasMixedScriptWord(v), false, v);
  }
  const base = { email: "a@example.invalid", password: "long-enough-pw" };
  assert.equal(signupSchema.safeParse({ ...base, name: `P${cyr(0x430)}ypal Support` }).success, false);
  assert.equal(signupSchema.safeParse({ ...base, name: "Иван Петров" }).success, true);
  assert.equal(createGuestSchema.safeParse({ firstName: `${cyr(0x391)}nna`, lastName: "Ruiz" }).success, false);
  assert.equal(createGuestSchema.safeParse({ firstName: "Ana", lastName: `R${cyr(0x443)}iz` }).success, false);
  assert.equal(createGuestSchema.safeParse({ firstName: "Νίκος", lastName: "Ruiz" }).success, true);
  assert.equal(createWeddingSchema.safeParse({ name: `Ana & B${cyr(0x3bf)} 2027` }).success, false);
  assert.equal(duplicateWeddingSchema.safeParse({ name: `Ana & B${cyr(0x3bf)} 2027` }).success, false);
  assert.equal(createWeddingSchema.safeParse({ name: "Ana & Bo 2027" }).success, true);
  // Names saved before the rule aren't put into an email either.
  const { emailSafePersonName, emailSafeWeddingName } = await import("./email-safe-names");
  assert.equal(emailSafePersonName(`P${cyr(0x430)}ypal`), null);
  assert.equal(emailSafeWeddingName(`Ana & B${cyr(0x3bf)}`), null);
  assert.equal(emailSafePersonName("Иван"), "Иван");
});

test("the name rules still accept the real names people use", () => {
  const ok = (name: string) => createGuestSchema.safeParse({ firstName: name, lastName: "Smith" }).success;
  for (const v of ["J. R.", "Mary-Jane", "O'Neil", "St. Clair", "Anne-Marie", "José", "Zoë", "Иван", "Νίκος", "李", "Nguyễn", "D'Angelo", "Jr."]) {
    assert.equal(ok(v), true, v);
  }
  for (const v of ["x.com", "seatwise-help-a.com", "evil. com"]) assert.equal(ok(v), false, v);
});

// TS-258: a web address whose ending is spelled with spaces between its letters.
test("a web address with spaces between the letters of its ending is caught", () => {
  for (const v of [
    "evil . c o m",
    "e v i l . c o m",
    "evil.c o m",
    "evil . n e t",
    "evil . C O M",
    "visit x . o r g today",
    "evil dot c o m",
  ]) {
    assert.equal(looksLikeWebAddress(v), true, v);
  }
  const base = { email: "a@example.invalid", password: "long-enough-pw" };
  assert.equal(signupSchema.safeParse({ ...base, name: "e v i l . c o m" }).success, false);
  assert.equal(weddingNameField.safeParse("evil . c o m").success, false);
});

// TS-258: real names with periods and spaces still pass.
test("real names with periods and spaces still pass the spaced-letters check", () => {
  for (const v of [
    "St. Pierre",
    "Jean-Luc St. Pierre",
    "Mary Ann",
    "J. R. R. Smith",
    "Dr. Who",
    "Ó Súilleabháin",
    "Lee . Kim",
    "Bo. Coleman",
    "Ana B. Orgel",
    "Ana B. Netherton",
    "Ana B. Co Morgan",
    "Ana B. Ne Thompson",
  ]) {
    assert.equal(looksLikeWebAddress(v), false, v);
  }
});

// TS-258: every name in the sample guest import file still passes.
test("every name in docs/sample-guest-import.csv still passes the web-address check", () => {
  const csv = readFileSync(fileURLToPath(new URL("../../../../docs/sample-guest-import.csv", import.meta.url)), "utf8");
  const { headers, rows } = parseCsv(csv.replace(/^﻿/, ""));
  const first = headers.indexOf("First Name");
  const last = headers.indexOf("Last Name");
  const plusOnes = headers.indexOf("Plus-ones");
  assert.ok(first >= 0 && last >= 0 && plusOnes >= 0, headers.join("|"));
  const names: string[] = [];
  for (const row of rows) {
    names.push(row[first], row[last], `${row[first]} ${row[last]}`.trim());
    for (const p of (row[plusOnes] ?? "").split(",")) if (p.trim()) names.push(p.trim());
  }
  assert.ok(names.length >= 60);
  for (const name of names.filter((n) => n && n.trim())) {
    assert.equal(looksLikeWebAddress(name), false, name);
  }
});
