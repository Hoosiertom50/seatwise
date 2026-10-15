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
function importOne(bytes: Uint8Array, row = 0): "refused" | { firstName: string; lastName: string } {
  const { text, encoding } = decodeCsvFile(bytes);
  const prepared = prepareImportCsv(text, encoding, NAMES);
  if ("error" in prepared) {
    assert.ok(prepared.error.startsWith(MAC_ENCODING_MESSAGE), prepared.error);
    return "refused";
  }
  const { headers, rows } = parseCsv(prepared.csv);
  const parsed = parseGuestImportRow(rows[row], headers, NAMES, SIDES);
  assert.deepEqual(parsed.errors, []);
  return { firstName: parsed.data.firstName!, lastName: parsed.data.lastName! };
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

// PR #115 review (Copilot round 4).
test("PR #115: a dot-like accent on the ending's last letter doesn't hide a web address", () => {
  const dotBelow = "\u0323";
  const dotAbove = "\u0307";
  for (const name of [`evil${dotBelow}com${dotAbove}`, `evil${dotBelow}com${dotBelow}`, `evil${dotBelow}net${dotBelow}`]) {
    assert.equal(looksLikeWebAddress(name), true, name);
    assert.equal(weddingNameField.safeParse(name).success, false, name);
  }
  // Igbo and Yoruba names with dots below still pass.
  for (const name of ["Ọrụ", "Ngozi Ọkọnkwọ", "Adéṣọlá Ọ̀kọ̀", "Ṣọlá Ọ̀ṣun", "Ọmọ́tọ́lá", "Chukwuemeka Ọnwụ"]) {
    assert.equal(looksLikeWebAddress(name), false, name);
  }
});


test("PR #115: Romanian names starting with Î import from a Windows file that shows it's one", () => {
  for (const [first, last] of [["Ion", "Întorsureanu"], ["Î.", "Popescu"]]) {
    assert.deepEqual(
      importOne(bytesFor("windows-1252", `First name,Last name\r\nZoé,Lee\r\n${first},${last}\r\n`), 1),
      { firstName: first, lastName: last },
      `${first} ${last}`
    );
  }
  // With nothing else in the file to show it's Windows, a Mac file's "Ó Briain" and "Œuvray" are still caught.
  for (const [first, last] of [["Sean", "Ó Briain"], ["Anne", "Œuvray"]]) {
    assert.equal(importOne(bytesFor("macintosh", `First name,Last name\r\n${first},${last}\r\n`)), "refused", `${first} ${last}`);
  }
});

// PR #115 review (Copilot round 6).
test("PR #115: a separator between two letters doesn't hide a web address", () => {
  const middleDot = "\u00B7";
  const maqaf = "\u05BE";
  for (const name of [`l${middleDot}l.cat`, `א${maqaf}ב.il`]) {
    assert.equal(looksLikeWebAddress(name), true, name);
    assert.equal(weddingNameField.safeParse(name).success, false, name);
  }
  // Names that use them still pass.
  for (const name of [`Gal${middleDot}la`, `Col${middleDot}lell Puig`, `בן${maqaf}עמי`, "ジョン\u30FBスミス"]) {
    assert.equal(looksLikeWebAddress(name), false, name);
  }
});

// PR #115 review (Copilot round 7).
test("PR #115: a separator and an accent together don't hide a web address", () => {
  const middleDot = "\u00B7";
  const macron = "\u0304";
  const dotBelow = "\u0323";
  for (const name of [`l${middleDot}l.c${macron}at`, `ev${middleDot}il${dotBelow}com`]) {
    assert.equal(looksLikeWebAddress(name), true, name);
    assert.equal(weddingNameField.safeParse(name).success, false, name);
  }
  for (const name of [`Gal${middleDot}la`, `Col${middleDot}lell Puig`, "Ngozi Ọkọnkwọ"]) {
    assert.equal(looksLikeWebAddress(name), false, name);
  }
});

// PR #115 review (Copilot round 8).
test("PR #115: a nickname opened with a straight quote and closed with a curly one isn't a Mac sign", () => {
  for (const cell of ["Robert 'Bobby J’", "Robert 'A-J’", "Robert 'Lil Bit’"]) {
    assert.equal(looksLikeMacRoman(cell, true, true, false), false, cell);
  }
  // An apostrophe inside a name doesn't open one: the Irish Ní after it is still caught.
  for (const cell of ["N’ Bhriain", "Máire O'Neill N’ Bhriain"]) assert.equal(looksLikeMacRoman(cell, true, true, false), true, cell);
});

test("PR #115: a dot-like accent inside a web ending doesn't hide it", () => {
  const dotBelow = "\u0323";
  const dotAbove = "\u0307";
  for (const name of [`evil${dotBelow}co${dotAbove}m`, `evil${dotBelow}c${dotAbove}om`]) {
    assert.equal(looksLikeWebAddress(name), true, name);
    assert.equal(weddingNameField.safeParse(name).success, false, name);
  }
  for (const name of ["Tọ́pẹ́", "Ọlátọ́pẹ́", "Tẹ̀mítọ́pẹ́", "Ọmọ́tọ́ṣọ̀", "Ṣọ̀pẹ́", "Ọkọrọafọr", "Nwọkọcha"]) {
    assert.equal(looksLikeWebAddress(name), false, name);
  }
});

// Review 16.
test("Review 16: the joiner check takes time in line with the name's length, not its square", () => {
  const dotBelow = "\u0323";
  const fatha = "\u064E";
  const zwnj = "\u200C";
  const started = performance.now();
  assert.equal(hasHiddenCharacters("a" + dotBelow.repeat(19_999)), false);
  assert.equal(hasHiddenCharacters("ب" + fatha.repeat(19_997) + zwnj + "ب"), false);
  // A guest import's worth of names made of marks (5,000 rows, two names each) took 17 seconds.
  for (let i = 0; i < 10_000; i++) hasHiddenCharacters("a" + dotBelow.repeat(99));
  assert.ok(performance.now() - started < 1_000, `took ${Math.round(performance.now() - started)} ms`);
  // Still: joiners inside a Persian or Sinhala word are spelling, elsewhere hidden characters.
  assert.equal(hasHiddenCharacters(`علی${zwnj}رضا`), false);
  assert.equal(hasHiddenCharacters("ශ්\u200Dරී"), false);
  assert.equal(hasHiddenCharacters(`علی${zwnj}राम`), true);
  assert.equal(hasHiddenCharacters(`evil${zwnj}com`), true);
});

test("Review 16: a capital and a curly apostrophe before a space don't get a Windows file refused", () => {
  for (const [first, last] of [["Anita", "D’ Souza"], ["Rosa", "D’ Angelo"], ["Sean", "O’ Brien"], ["Bob", "JONES’"], ["Al", "AJ’"]]) {
    assert.equal(looksLikeMacRoman(last, true, true, false), false, last);
    assert.deepEqual(
      importOne(bytesFor("windows-1252", `First name,Last name\r\n${first},${last}\r\n`)),
      { firstName: first, lastName: last.replace("’", "'") },
      `${first} ${last}`
    );
  }
  // The Mac's "Ní" (N’ then a space) is still caught when nothing else shows the file is Windows.
  assert.equal(looksLikeMacRoman("N’ Bhriain", true, true, false), true);
  assert.equal(importOne(bytesFor("macintosh", "First name,Last name\r\nAine,Ní Bhriain\r\n")), "refused");
});

test("Review 16: the Tibetan tsheg counts only between two Tibetan letters", () => {
  const tsheg = "\u0F0B";
  for (const name of [`paypal${tsheg}com`, `bit${tsheg}ly`]) {
    assert.equal(createGuestSchema.safeParse({ firstName: name, lastName: "Lee" }).success, false, name);
    assert.equal(weddingNameField.safeParse(name).success, false, name);
  }
  assert.equal(createGuestSchema.safeParse({ firstName: `བཀྲ${tsheg}ཤིས`, lastName: "Dolma" }).success, true);
});

test("Review 16: a Yoruba or Igbo dot below after an initial isn't read as a two-letter web ending", () => {
  for (const name of ["A.Mẹ", "T. Mẹ", "Ọrụ", "Ngozi Ọkọnkwọ"]) {
    assert.equal(looksLikeWebAddress(name), false, name);
    assert.equal(createGuestSchema.safeParse({ firstName: "Ade", lastName: name }).success, true, name);
  }
  // A longer ending still counts, with or without the dot below; two letters with no mark too.
  for (const name of ["x.cọm", "evil . cọm", "A.Me", "Ana.Mẹ"]) assert.equal(looksLikeWebAddress(name), true, name);
});

test("Review 16: \"dot\" spelled out takes every web ending; a spaced dot a few more", () => {
  for (const name of ["evil dot co", "evil dot io", "evil dot me", "evil . me", "paypal . co . uk", "evil dot com"]) {
    assert.equal(looksLikeWebAddress(name), true, name);
  }
  // Names with an initial still pass.
  for (const name of ["T. Ly", "J. Link", "J. Co", "Ms. Io", "Ana B. Co Morgan", "Dot Smith", "Mary Dot Lee", "St. Pierre"]) {
    assert.equal(looksLikeWebAddress(name), false, name);
  }
});

test("Review 16: Malayalam and Bengali names typed the older way (a joiner after a final virama) pass", () => {
  for (const name of ["അര്‍ജുന്‍", "മോഹന്‍ലാല്‍", "শরত্‍"]) {
    assert.equal(hasHiddenCharacters(name), false, name);
    assert.equal(createGuestSchema.safeParse({ firstName: name, lastName: "Nair" }).success, true, name);
  }
  // Anywhere else a joiner at the end of a word is still a hidden character.
  assert.equal(hasHiddenCharacters("Arjun\u200D"), true);
  assert.equal(hasHiddenCharacters("राम\u200D"), true);
});

// PR #116 review (Copilot).
test("PR #116: the dot-below exception is only for an initial and a two-letter name", () => {
  // Compatibility forms with no dot below at all are still caught.
  for (const name of ["x.\uFF4D\uFF45", "t.\u1D50\u1D49", "x.\uFF4D\uFF45 evil"]) {
    assert.equal(looksLikeWebAddress(name), true, name);
    assert.equal(weddingNameField.safeParse(name).success, false, name);
  }
  // A spaced or spelled-out dot with a dot below is still caught, and so is a second address beside an initial.
  for (const name of ["evil . mẹ", "evil dot mẹ", "A.Mẹ evil . mẹ"]) {
    assert.equal(looksLikeWebAddress(name), true, name);
  }
  // The initial-and-name spellings still pass.
  for (const name of ["A.Mẹ", "T. Mẹ", "Ọ.Mẹ", "Ọ. Mẹ", "Ọrụ", "Tọ́pẹ́"]) assert.equal(looksLikeWebAddress(name), false, name);
});

test("PR #116: the tsheg needs a Tibetan letter on each side, not just a Tibetan mark", () => {
  const tsheg = "\u0F0B";
  const aa = "\u0F71";
  for (const name of [`paypal${aa}${tsheg}${aa}com`, `བཀྲ${tsheg}${tsheg}ཤིས`]) {
    assert.equal(createGuestSchema.safeParse({ firstName: name, lastName: "Lee" }).success, false, name);
    assert.equal(weddingNameField.safeParse(name).success, false, name);
  }
  for (const name of [`བཀྲ${tsheg}ཤིས`, `ཨ${aa}${tsheg}ཡ`, `བཀྲ${tsheg}ཤིས${tsheg}བདེ${tsheg}ལེགས`]) {
    assert.equal(createGuestSchema.safeParse({ firstName: name, lastName: "Dolma" }).success, true, name);
  }
});

// Review 17.
test("Review 17: the Mac's Irish Uí, and Ní at the end of a cell, are caught when nothing shows the file is Windows", () => {
  for (const cell of ["U’ Bhriain", "N’", "N’ Bhriain"]) assert.equal(looksLikeMacRoman(cell, true, true, false), true, cell);
  assert.equal(importOne(bytesFor("macintosh", "First name,Last name\r\nNora,Uí Bhriain\r\n")), "refused");
  // Windows names stay fine.
  for (const cell of ["D’ Souza", "O’ Brien", "Robert ‘JN’ Lee"]) assert.equal(looksLikeMacRoman(cell, true, true, false), false, cell);
});

test("Review 17: an initial with a dot below that spells a one-letter short link still counts", () => {
  const dotBelow = "\u0323";
  for (const name of [`t.me${dotBelow}`, `t.ly${dotBelow}`, `j.m${dotBelow}p`]) assert.equal(looksLikeWebAddress(name), true, name);
  for (const name of ["A.Mẹ", "Ọ.Mẹ", "T. Mẹ"]) assert.equal(looksLikeWebAddress(name), false, name);
});

test("Review 17: a spaced initial or title before a two-letter name, and Dot as a name, aren't web addresses", () => {
  for (const name of ["T. Mễ", "Dr. Mê", "J. Me", "S. Uk", "Jae U. Uk", "Mr. Uk", "A. Tv", "Anna Dot Ly", "Sam and Dot Ly Wedding", "Mary Dot Co", "Polka Dot Club", "Tom and Dot Live Here"]) {
    assert.equal(looksLikeWebAddress(name), false, name);
    assert.equal(weddingNameField.safeParse(name).success, true, name);
  }
  // Still caught.
  for (const name of ["evil . me", "evil dot ly", "evil Dot com", "paypal . co . uk", "t.me", "x.me"]) assert.equal(looksLikeWebAddress(name), true, name);
});

test("Review 17: a joiner after a virama ends a word only after a Bengali or Malayalam letter", () => {
  const zwj = "\u200D";
  for (const name of [`Smith\u09CD${zwj}`, `ab\u09CD${zwj} Smith`]) {
    assert.equal(createGuestSchema.safeParse({ firstName: name, lastName: "Lee" }).success, false, name);
  }
  for (const name of ["അര്‍ജുന്‍", "শরত্‍"]) assert.equal(createGuestSchema.safeParse({ firstName: name, lastName: "Nair" }).success, true, name);
});

// Review 18.
test("Review 18: the name readings need a name's capitals -- lowercase spaced and Dot addresses still count", () => {
  for (const name of ["go . me", "x . uk", "ab . tv", "paypal-co . uk", "evil-ab . me", "Visit go . me now", "evil Dot Co", "evil Dot co", "bit Dot Ly", "Visit tinyurl Dot Co", "paypal Dot Co . uk"]) {
    assert.equal(looksLikeWebAddress(name), true, name);
    assert.equal(weddingNameField.safeParse(name).success, false, name);
  }
  for (const name of ["T. Mễ", "Dr. Mê", "J. Me", "Jae U. Uk", "Mr. Uk", "A. Tv", "Anna Dot Ly", "Sam and Dot Ly Wedding", "Polka Dot Club", "Tom and Dot Live Here", "Dot Ly"]) {
    assert.equal(looksLikeWebAddress(name), false, name);
  }
});

test("Review 18: the name readings take time in line with the name's length", () => {
  const started = performance.now();
  for (const text of [" ".repeat(40_000), "a" + " ".repeat(40_000) + ". x", "Ab Dot ".repeat(3_000), "T. Me ".repeat(3_000)]) looksLikeWebAddress(text);
  assert.ok(performance.now() - started < 1_000, `took ${Math.round(performance.now() - started)} ms`);
});

test("Review 18: the joiner after a virama needs a Bengali or Malayalam letter, not just one of their marks", () => {
  const zwj = "\u200D";
  for (const marks of ["\u09BC\u09CD", "\u09CD\u09CD", "\u09BE\u09CD", "\u0D3E\u0D4D", "\u0D4D\u0D4D"]) {
    const name = `Smith${marks}${zwj}`;
    assert.equal(createGuestSchema.safeParse({ firstName: name, lastName: "Lee" }).success, false, name);
  }
  for (const name of ["অর্জুন্‍", "পড়্‍", "শরত্‍", "അര്‍ജുന്‍"]) {
    assert.equal(createGuestSchema.safeParse({ firstName: name, lastName: "Nair" }).success, true, name);
  }
});

