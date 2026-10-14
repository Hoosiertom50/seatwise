// Review 15: name rules and guest-import encoding checks found in the fifteenth review. Run with
// `pnpm --filter @seatwise/web test`.
//   B5 (Tom, 10-14: allow them): real spellings that need a joining character or a mark between
//      letters -- Persian with a zero-width non-joiner, Sinhala with a zero-width joiner, Catalan
//      l·l, Japanese ・, Hebrew maqaf, Tibetan tsheg -- are accepted; the same characters anywhere
//      else (a joiner in a Latin name, a dot doubled or at the edge) are still refused.
//   B4: one-letter short-link hosts (t.me, j.mp) are web addresses; "J.Page", "R.De Silva" are names.
//   B6: windows-1252 names with ’ after a "y" or after two vowels import (Ny’asia, Tia’sia).
//   B7: Mac Roman files whose only accented letters are Irish Í/Ó, œ or Turkish ı are caught.
import { test } from "node:test";
import assert from "node:assert/strict";

const { looksLikeWebAddress, looksLikePhoneNumber, hasHiddenCharacters } = await import("../../../../packages/shared/src/validation");
const { createGuestSchema } = await import("../../../../packages/shared/src/schemas/guest");
const { weddingNameField } = await import("../../../../packages/shared/src/schemas/wedding");
const { signupSchema } = await import("../../../../packages/shared/src/schemas/auth");
const { emailSafePersonName } = await import("../../../../packages/shared/src/email-safe-names");
const { parseCsv } = await import("../../../../packages/shared/src/csv");
const { parseGuestImportRow } = await import("../../../../packages/shared/src/guest-import-row");
const { decodeCsvFile, looksLikeMacRoman, MAC_ENCODING_MESSAGE } = await import("../../../../packages/shared/src/text-decode");
const { prepareImportCsv } = await import("./guest-import-client");

const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);
const MAQAF = String.fromCodePoint(0x05be);
const TSHEG = String.fromCodePoint(0x0f0b);

function personErrors(name: string): string[] {
  const r = createGuestSchema.safeParse({ firstName: name, lastName: "Lee" });
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

test("B5: real names that need a joiner or a mark between letters are accepted", () => {
  const names = [
    `علی${ZWNJ}رضا`, // Persian Alireza
    `ශ්${ZWJ}රී`, // Sinhala Sri
    `චන්ද්${ZWJ}රිකා`, // Sinhala Chandrika
    "Gal·la", "Paral·lel", "Pere Gal·la",
    "ジョン・スミス", "エミリー・ブラウン",
    `בן${MAQAF}גוריון`, `בֶּן${MAQAF}גּוּרְיוֹן`, // Ben-Gurion, without and with niqqud
    `བསྟན${TSHEG}འཛིན`, // Tibetan Tenzin
  ];
  for (const name of names) {
    assert.deepEqual(personErrors(name), [], name);
    assert.equal(signupSchema.safeParse({ name, email: "a@example.invalid", password: "Abcdefgh1234!xyz" }).success, true, name);
    assert.equal(emailSafePersonName(name), name.normalize("NFC"), name);
  }
  assert.equal(weddingNameField.safeParse("Gal·la & Jordi").success, true);
  assert.equal(weddingNameField.safeParse(`علی${ZWNJ}رضا & Sara`).success, true);
});

test("B5: the same characters anywhere else are still refused", () => {
  const refused = [
    `Ann${ZWJ}a`, // a joiner inside a Latin name is a hidden character
    `${ZWNJ}علی`, // at the start
    `علی${ZWNJ}`, // at the end
    `Ana${ZWNJ}رضا`, // between a Latin and an Arabic letter
    "·Anna", "Anna·", "Gal··la", "Gal· la", // not between two letters
    `${MAQAF}בן`, `בן${MAQAF}`,
  ];
  for (const name of refused) assert.notDeepEqual(personErrors(name), [], name);
  // A middle dot still reads as a dot before the endings scam links use.
  for (const v of ["paypal·com", "evil・net"]) assert.equal(looksLikeWebAddress(v), true, v);
});

test("B4: one-letter short-link hosts are web addresses; an initial before a surname isn't", () => {
  for (const v of ["t.me", "Join T.me", "m.me", "j.mp", "x.tv", "y.gl", "z.uk"]) {
    assert.equal(looksLikeWebAddress(v), true, v);
  }
  for (const v of ["J.Page", "R.De Silva", "Ana B.De Souza", "M.In", "T.To", "A.Ca"]) {
    assert.equal(looksLikeWebAddress(v), false, v);
  }
});

// The import checks, as in ts-265-names-mac-and-wedding-delete.test.mts.
function bytesFor(encoding: string, text: string): Uint8Array {
  const decoder = new TextDecoder(encoding);
  const byChar = new Map<string, number>();
  for (let b = 0; b < 256; b++) byChar.set(decoder.decode(new Uint8Array([b])), b);
  return new Uint8Array([...text].map((ch) => byChar.get(ch)!));
}
const NAMES = { firstName: "First name", lastName: "Last name" };
const SIDES = { sideLabel1: "Bride", sideLabel2: "Groom" };
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

test("B6: windows-1252 names with ’ after a y or after two vowels import", () => {
  for (const name of ["Ny’asia", "Ky’ree", "Jy’mir", "Ty’asia", "Tia’sia", "Sha’sia", "Mia’sia", "Bre’ssa", "Nia’zia"]) {
    assert.equal(looksLikeMacRoman(name, true, true, false), false, name);
    assert.deepEqual(importOne(bytesFor("windows-1252", `First name,Last name\r\n${name},Lee\r\n`)), { firstName: name.replace("’", "'"), lastName: "Lee" }, name);
  }
});

test("B7: Mac Roman files whose only accents are Irish Í/Ó, œ or Turkish ı are caught", () => {
  // Unaccented first names, so the name being tested is the only sign in the file.
  for (const [first, last] of [["Aine", "Ní Bhriain"], ["Sean", "Ó Briain"], ["Anne", "Œuvray"], ["Marc", "Bœuf"], ["Ilgın", "Lee"]]) {
    assert.equal(importOne(bytesFor("macintosh", `First name,Last name\r\n${first},${last}\r\n`)), "refused", `${first} ${last}`);
  }
  // The same names saved by Windows still import as typed.
  for (const [first, last] of [["Seán", "Ó Briain"], ["Marc", "Bœuf"], ["Áine", "Ní Bhriain"]]) {
    assert.deepEqual(importOne(bytesFor("windows-1252", `First name,Last name\r\n${first},${last}\r\n`)), { firstName: first, lastName: last }, `${first} ${last}`);
  }
});

// PR #115 review (Copilot round 1).
test("PR #115: a quoted nickname's closing ’ isn't the Irish-Ní Mac sign", () => {
  assert.equal(looksLikeMacRoman("Robert ‘AJ’", true, true, false), false);
  assert.deepEqual(importOne(bytesFor("windows-1252", "First name,Last name\r\nRobert ‘AJ’,Lee\r\n")), { firstName: "Robert 'AJ'", lastName: "Lee" });
  assert.equal(looksLikeMacRoman("N’ Bhriain", true, true, false), true);
});

// PR #115 review (Copilot round 2).
test("PR #115: a nickname of several words, or with a hyphen or dot, isn't the Irish-Ní Mac sign", () => {
  for (const cell of ["Robert ‘Bobby J’", "Robert ‘A-J’", "Robert ‘A.J’", "Robert “Bobby J’"]) {
    assert.equal(looksLikeMacRoman(cell, true, true, false), false, cell);
  }
  assert.deepEqual(importOne(bytesFor("windows-1252", "First name,Last name\r\nRobert ‘Bobby J’,Lee\r\n")), { firstName: "Robert 'Bobby J'", lastName: "Lee" });
  for (const cell of ["N’ Bhriain", "Máire N’ Bhriain"]) assert.equal(looksLikeMacRoman(cell, true, true, false), true, cell);
});

test("PR #115: Arabic with a vowel mark before a dot and Latin letters is a web address", () => {
  assert.equal(looksLikeWebAddress("بنكِ.de"), true);
  assert.equal(looksLikeWebAddress("بنك.de"), true);
  // A Latin letter's accents are still not a script's own sign.
  assert.equal(looksLikeWebAddress("Ọ̀.Adé"), false);
});

test("PR #115: digits outside the basic plane count once each (an Osmanya year isn't a phone number)", () => {
  const osmanya2026 = String.fromCodePoint(0x104a2, 0x104a0, 0x104a2, 0x104a6);
  assert.equal(looksLikePhoneNumber(`Est. ${osmanya2026}`), false);
  assert.equal(weddingNameField.safeParse(`Est. ${osmanya2026}`).success, true);
  const osmanyaPhone = String.fromCodePoint(0x104a8, 0x104a0, 0x104a0, 0x104a5, 0x104a5, 0x104a5, 0x104a1);
  assert.equal(looksLikePhoneNumber(`Call ${osmanyaPhone}`), true);
});

// PR #115 review (Copilot round 3).
test("PR #115: a joiner counts as part of the spelling only between two letters of the same script", () => {
  const zwnj = "\u200C";
  const zwj = "\u200D";
  // Persian and Sinhala spellings still pass.
  assert.equal(hasHiddenCharacters(`علی${zwnj}رضا`), false);
  assert.equal(hasHiddenCharacters(`ශ්${zwj}රී`), false);
  assert.equal(createGuestSchema.safeParse({ firstName: `علی${zwnj}رضا`, lastName: "Ahmadi" }).success, true);
  // Between two scripts it's a hidden character.
  for (const name of [`علی${zwnj}राम`, `राम${zwj}علی`, `बैंक${zwnj}ক`]) {
    assert.equal(hasHiddenCharacters(name), true, name);
    assert.equal(createGuestSchema.safeParse({ firstName: name, lastName: "Lee" }).success, false, name);
  }
});

test("PR #115: a middle dot before a non-Latin web ending reads as a web address, as a full stop does", () => {
  const middleDot = "\u00B7";
  const katakanaDot = "\u30FB";
  for (const name of [`بنك${middleDot}مصر`, `बैंक${middleDot}कॉम`, `بنك${katakanaDot}مصر`]) {
    assert.equal(looksLikeWebAddress(name), true, name);
    assert.equal(weddingNameField.safeParse(name).success, false, name);
  }
  // Names written with a middle dot still pass -- Japanese, Catalan, and an initial before "Bharat".
  for (const name of [`ジョン${katakanaDot}スミス`, `Gal${middleDot}la Puig`, `राम${middleDot}भारत`]) {
    assert.equal(looksLikeWebAddress(name), false, name);
  }
  // A Latin ending after a middle dot still takes a full stop (a common scam ending is caught anyway).
  assert.equal(looksLikeWebAddress(`بنك${middleDot}de`), false);
});
