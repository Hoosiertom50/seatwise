// TS-190 (Tom's decision): a guest file saved by Excel on Windows as plain "CSV" isn't UTF-8 -- it
// uses the older Windows encoding (windows-1252), so "Müller" came through as "M�ller". The file's
// bytes are read as UTF-8 when they are valid UTF-8, and as windows-1252 otherwise.
// TS-198: a file that starts with a UTF-16 byte-order mark (Excel's "Unicode Text", some Google
// and Numbers exports) is read as UTF-16. And a file saved in the older Mac encoding (Mac Roman),
// which windows-1252 would turn into "RenŽe" or "MŸller", is refused with the "save it as CSV
// UTF-8" message rather than imported with the wrong letters.
// TS-210: a file that starts with the UTF-8 byte-order mark (every Seatwise export, Excel's "CSV
// UTF-8") is always read as UTF-8 -- one stray byte used to make the whole file read as
// windows-1252, garbling every accented letter ("JesÃºs"), and the import saved that. Now only
// the stray byte becomes the "couldn't read" mark (U+FFFD), and the import flags just that cell.
// A file without the mark that is mostly UTF-8 but has a stray byte (read as windows-1252 it
// would show "Ã©" for "é") is refused. The Mac check moved out of here: it only looks at the
// cells an import uses (findMacRomanCell), so a Windows file isn't refused over a column that
// isn't even imported.

export type CsvTextEncoding = "utf-8" | "utf-16" | "windows-1252";

export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): string {
  return decodeCsvFile(bytes).text;
}

/** TS-210: the file's text, and the encoding it was read with (the Mac check needs to know). */
export function decodeCsvFile(bytes: ArrayBuffer | Uint8Array): { text: string; encoding: CsvTextEncoding } {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(view), encoding: "utf-16" };
  }
  if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(view), encoding: "utf-16" };
  }
  // TS-210: UTF-16 saved without the byte-order mark (every other byte is zero for plain letters).
  const utf16 = utf16WithoutBom(view);
  if (utf16) return { text: new TextDecoder(utf16).decode(view), encoding: "utf-16" };
  // TS-210: with the UTF-8 mark, never anything else -- a bad byte becomes U+FFFD (see above).
  if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(view), encoding: "utf-8" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(view);
    // TS-256: a Windows file that happens to be valid UTF-8 ("café »" -> "caf項") -- see below.
    if (isWindowsFrenchSpacingOnly(view)) return { text: new TextDecoder("windows-1252").decode(view), encoding: "windows-1252" };
    return { text, encoding: "utf-8" };
  } catch {
    // TS-210: mostly UTF-8 with a stray byte -- windows-1252 would garble every accented letter.
    if (hasUtf8LetterPairs(view)) throw new CsvEncodingError(MIXED_ENCODING_MESSAGE);
    return { text: new TextDecoder("windows-1252").decode(view), encoding: "windows-1252" };
  }
}

/** TS-198: a file read as windows-1252 whose letters show it was really saved in the older Mac encoding. */
export class CsvEncodingError extends Error {}

export const MAC_ENCODING_MESSAGE =
  "Some letters in this file couldn't be read correctly (it looks like an older Mac format) — save it as 'CSV UTF-8' and choose it again.";

// TS-210
export const MIXED_ENCODING_MESSAGE =
  "Some letters in this file couldn't be read correctly (part of it is saved in a different text format, so \"é\" would come out as \"Ã©\") — save it as 'CSV UTF-8' and choose it again.";

function utf16WithoutBom(view: Uint8Array): "utf-16le" | "utf-16be" | null {
  const n = Math.min(view.length - (view.length % 2), 400);
  if (n < 4) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < n; i += 2) {
    if (view[i] === 0) evenZeros++;
    if (view[i + 1] === 0) oddZeros++;
  }
  const pairs = n / 2;
  // TS-243: a few zeros on the other half too (at most 10%) -- a character whose code ends in 00
  // (一, Ā, Ō, Ѐ) has one there, and requiring none read such a file as UTF-8 full of zeros.
  if (oddZeros >= pairs * 0.9 && evenZeros <= pairs * 0.1) return "utf-16le";
  if (evenZeros >= pairs * 0.9 && oddZeros <= pairs * 0.1) return "utf-16be";
  return null;
}

/**
 * TS-210: whether the bytes hold a UTF-8 letter that windows-1252 would show as two or three odd
 * characters ("Ã©", "Ã±", "Å¡", "â€™"). Two-byte letters starting with C6-DF are left out: read as
 * windows-1252 they are a capital accented letter then a quote or dash ("É”"), which real text has.
 * TS-233: a three-byte sequence is no longer enough on its own -- in a real Windows file a small
 * accented letter, a no-break space and a French quote ("café »", bytes E9 A0 BB) look like one.
 * A three-byte sequence counts only when it is a UTF-8 dash, quote, ellipsis or euro sign ("â€™",
 * which real Windows text never has), or a letter -- and letters only when there are two or more and
 * more of them than stray bytes (a file that is mostly UTF-8 has many letters and a stray byte or two; a
 * Windows file has many lone accented letters and the odd accidental "letter").
 */
function hasUtf8LetterPairs(view: Uint8Array): boolean {
  const cont = (b: number | undefined) => b !== undefined && b >= 0x80 && b <= 0xbf;
  let threeByteLetters = 0;
  let strayBytes = 0;
  for (let i = 0; i < view.length; i++) {
    const b = view[i];
    if (b < 0x80) continue;
    if (b >= 0xc2 && b <= 0xc5 && cont(view[i + 1])) return true;
    if (b >= 0xf0 && b <= 0xf4 && cont(view[i + 1]) && cont(view[i + 2]) && cont(view[i + 3])) return true;
    if (b >= 0xe0 && b <= 0xef && cont(view[i + 1]) && cont(view[i + 2])) {
      // TS-237: a windows-1252 small letter, a no-break space and a punctuation mark ("é »", bytes
      // E9 A0 BB) is how French text looks, so it is no evidence either way -- even repeated
      // ("café » café »" used to count as two UTF-8 letters and refuse a Windows file).
      if (view[i + 1] === 0xa0 && isWindows1252Punctuation(view[i + 2])) {
        i += 2;
        continue;
      }
      const codePoint = ((b & 0x0f) << 12) | ((view[i + 1] & 0x3f) << 6) | (view[i + 2] & 0x3f);
      // Not a real three-byte character (too small, or half of a UTF-16 pair): just stray bytes.
      if (codePoint >= 0x800 && (codePoint < 0xd800 || codePoint > 0xdfff)) {
        // TS-233: U+2000-U+20CF -- dashes, curly quotes, the ellipsis, the euro sign.
        if (codePoint >= 0x2000 && codePoint <= 0x20cf) return true;
        if (/\p{L}/u.test(String.fromCodePoint(codePoint))) threeByteLetters++;
        i += 2;
        continue;
      }
    }
    if (b >= 0xc2 && b <= 0xdf && cont(view[i + 1])) {
      i += 1;
      continue;
    }
    strayBytes++;
  }
  return threeByteLetters > 1 && threeByteLetters > strayBytes;
}

/**
 * TS-256: whether every non-ASCII character in a file that is valid UTF-8 is really a windows-1252
 * small accented letter (E0-EF: à-ï), a no-break space and a punctuation mark, straight after a plain
 * letter ("café »", bytes E9 A0 BB) -- which UTF-8 reads as one rare CJK, Hangul or Mongolian
 * character stuck to a Latin word ("caf項"). A real UTF-8 file with Chinese, Japanese or Korean
 * names has characters with other second bytes, next to each other, after a comma or space -- so
 * any one of those, or any other non-ASCII byte at all, keeps the file UTF-8.
 */
function isWindowsFrenchSpacingOnly(view: Uint8Array): boolean {
  let found = false;
  for (let i = 0; i < view.length; i++) {
    const b = view[i];
    if (b < 0x80) continue;
    const before = view[i - 1];
    const plainLetterBefore = before !== undefined && ((before >= 0x41 && before <= 0x5a) || (before >= 0x61 && before <= 0x7a));
    if (b >= 0xe0 && b <= 0xef && plainLetterBefore && view[i + 1] === 0xa0 && view[i + 2] !== undefined && isWindows1252Punctuation(view[i + 2])) {
      found = true;
      i += 2;
      continue;
    }
    return false;
  }
  return found;
}

// TS-248: the bytes 80-9F that windows-1252 uses for marks rather than letters: € ‚ „ … † ‡ ˆ ‰ ‹ ‘ ’
// “ ” • – — ˜ ™ › (not ƒ Š Œ Ž š œ ž Ÿ, nor the five it leaves undefined).
const WINDOWS_1252_MARKS_80_9F = new Set([
  0x80, 0x82, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8b, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9b,
]);

/**
 * TS-237: A1-BF in windows-1252 (the same as Latin-1) that aren't letters: ¡ ¢ £ « » ¿ … (not ª µ º).
 * TS-248: and the marks in 80-9F -- an ellipsis is 85, so "café … café …" was refused.
 */
function isWindows1252Punctuation(b: number): boolean {
  if (WINDOWS_1252_MARKS_80_9F.has(b)) return true;
  return b >= 0xa1 && b <= 0xbf && b !== 0xaa && b !== 0xb5 && b !== 0xba;
}

// TS-198: the characters windows-1252 shows for Mac Roman's accented letters -- Ž is é, Ÿ is ü, ƒ is
// É, Š is ä, Œ is å, ‡ is á, ˆ is à, ‰ is â, † is Ü, ‹ is ã, › is õ, and the bytes windows-1252
// leaves undefined (Å, ç, è, ê, ù). Curly quotes (Mac í, ì, î, ë) are left out: "O’Brien" is a
// real name.
// TS-210: real windows-1252 letters and marks are no longer on the list -- š ž (Mac ö û), the dashes
// (Mac ñ ó) and ™ (Mac ô) refused "Kašpar", "Božena", "Mary–Kate" and "Seatwise™". The capitals Ž Š
// Œ Ÿ only count straight after a small letter ("RenŽe", "JosŽ", "MŸller"), which real text never
// has -- "Željko Žižek" is fine. And in a name, ’ or ‘ between two small letters ("Mar’a" for
// María), and ¿ or § after a letter ("S¿ren", "Strau§"), are the Mac signs too.
const MAC_ROMAN_NOT_LETTERS = "ƒ‡ˆ‰†‹›\u0081\u008d\u008f\u0090\u009d";
// TS-225: also a capital then Ž Š Œ Ÿ then a small letter ("MŸller" for Müller -- the comment above
// claimed it, but only "RenŽe" was caught), and ƒ ‡ ˆ ‰ † ‹ › starting a word before a letter
// ("ƒloise" for Éloise; TS-243: "‡ngel" is "ángel" in small letters -- 0x87 is Mac á. Ángel
// itself comes out as "çngel", caught by the TS-243 rule below). "Željko Žižek" and "HAŸ-LES-ROSES" are still fine.
const MAC_ROMAN_NOT_LETTERS_AT_START = "ƒ‡ˆ‰†‹›";
// TS-233: the start-of-word rule, like the curly-quote rule, is for names only -- in a Windows
// notes cell "‹VIP›" or "In memory of †Opa" is real text.
const MAC_ROMAN_IN_A_WORD = new RegExp(`\\p{L}[${MAC_ROMAN_NOT_LETTERS}]\\p{L}|\\p{Ll}[ŽŠŒŸ]|\\p{Lu}[ŽŠŒŸ]\\p{Ll}`, "u");
// TS-243: and in a name, Mac ú is œ ("Jesœs", "Raœl"): œ between small letters counts, except
// "œu" and "œi", which are French ("Lacœur", "Lœillet").
// TS-254: and Mac ú after a capital too ("Nœria" for Núria) -- French œ after a capital is "Cœur",
// "Bœuf". The rule for ’ between two small letters ("Mar’a" for María) moved below, since
// "Ka’iulani" and "Ja’nae" are real Windows names; ‘ between two small letters ("No‘l" for Noël)
// stays here. Also a small letter then ‘ or ’ at the end of a word -- Mac ë and í ("Zo‘" for Zoë,
// "Mart’" for Martí), which used to be made a plain apostrophe and saved as "Zo'" -- but not inside a
// quoted nickname ("Robert ‘Bob’", "Robert ‘Bobby Joe’", "‘Bobby-Joe’"). And the Mac's own curly apostrophes, which windows-1252 shows as
// Õ and Ô, inside a name ("OÕBrien", "DÔArcy", "KaÕiulani").
const MAC_ROMAN_IN_A_NAME = new RegExp(
  [
    `\\p{Ll}‘\\p{Ll}`,
    `\\p{L}[¿§]`,
    `(?<!\\p{L})[${MAC_ROMAN_NOT_LETTERS_AT_START}]\\p{L}`,
    `\\p{L}œ(?![ui])\\p{Ll}`,
    `(?<!['‘"“][\\p{L}\\p{M}]*)(?<![‘"“][\\p{L}\\p{M} .-]*)\\p{Ll}[’‘](?![\\p{L}\\p{M}])`,
    `\\p{Ll}[ÕÔ]\\p{L}|\\p{Lu}[ÕÔ]\\p{Lu}\\p{Ll}`,
  ].join("|"),
  "u"
);
// TS-254: two Mac signs that real Windows names have too, so they count only when nothing else in
// the file shows it's a Windows file (see WINDOWS_LETTERS):
// - ’ between two small letters: Mac í ("Mar’a" for María), but also "Ka’iulani", "Ja’nae";
// - š after a letter and before r h l n m s f d g b w z c: Mac ö ("Bjšrn", "Mšller", "Jšnsson").
//   Czech and Croatian names have š too ("Kašpar", "Hašek", "Dušan", "Miloš"), nearly always before a
//   vowel, k, p or t, or at the end of the word -- and such a file nearly always has other accented
//   letters (á, é, í, ý), which are the Windows sign.
// TS-256: three more, each kept to spots the real names never use:
// - ’ between two vowels is the Hawaiian ʻokina ("Ka’iulani", "Hawai’i") -- Mac í nearly always
//   follows a consonant ("Mar’a", "Garc’a"), so only that counts now (rare "Isaías" is the cost);
// - š before tt, tz, th, pf or pp: Mac ö ("Gšttsche", "Tšpfer", "Gštz") -- Czech never writes
//   those. And "šle" no longer counts, so Czech "Hašler" imports ("Mšller" still has "ll");
// - õ after a, or after another õ, with only consonants between, and not before a vowel: the Mac's
//   Turkish dotless ı ("Yõldõz", "Aydõn", "Sarõ"). Estonian õ is nearly always in a name's first
//   syllable ("Tõnis", "Mõttus", "Rõõmus"), and Portuguese õ always before e ("Simões", "Camões").
const MAC_ROMAN_IN_A_NAME_UNLESS_WINDOWS = new RegExp(
  [
    `[^\\P{Ll}aeiou]’\\p{Ll}|\\p{Ll}’[^\\P{Ll}aeiou]`,
    `\\p{L}š(?:(?!le)[rhlnmsfdgbwzc]|tt|tz|th|pf|pp)`,
    `[aAõ][b-df-hj-np-tv-z]+õ(?![aeiouõ])`,
  ].join("|"),
  "u"
);
// TS-254: a windows-1252 small accented letter after a small letter ("café", "Zoé"), or between a
// capital and a small letter ("Müller") -- in a Mac file those bytes are capitals (Á É Í...), which
// only show up that way in a word written in capitals ("MARTêN"). õ is left out: the Mac's dotless ı
// is õ in windows-1252 ("Yõldõz"). Or ’ next to a capital ("O’Brien", "De’Andre"), which a Mac file
// can't have (the Mac's own ’ is Õ in windows-1252).
const WINDOWS_SMALL_ACCENTED = "à-ôø-ÿö";
const WINDOWS_LETTERS = new RegExp(
  `\\p{Ll}[${WINDOWS_SMALL_ACCENTED}]|\\p{Lu}[${WINDOWS_SMALL_ACCENTED}]\\p{Ll}|\\p{Lu}’|’\\p{Lu}`,
  "u"
);
// TS-243: Mac capitals Á Ó Ú È Í Î Ô Ò Â Ê Ë are small accented letters in windows-1252 (ç î ò é ê
// ë ï ñ å æ è), so "Ángel" came out as "çngel" and "Óscar" as "îscar", and passed. A name word that
// starts with a small accented letter followed by a small letter is flagged -- but only when the
// file's names are written with capitals (a file typed all in small letters can hold a real
// "élodie").
const MAC_ROMAN_CAPITAL_READ_AS_SMALL = /(?<![\p{L}\p{M}'’‘])(?![a-z])\p{Ll}\p{Ll}/u;

/**
 * TS-210: whether one cell (read as windows-1252) looks like it was saved in the older Mac format.
 * TS-243: `namesWithCapitals` -- whether the file's names start with capitals (see above).
 * TS-254: `windowsFile` -- whether the file shows it's a Windows file (hasWindowsLetters).
 */
export function looksLikeMacRoman(cell: string, isName = false, namesWithCapitals = true, windowsFile = false): boolean {
  if (MAC_ROMAN_IN_A_WORD.test(cell)) return true;
  if (!isName) return false;
  if (!windowsFile && MAC_ROMAN_IN_A_NAME_UNLESS_WINDOWS.test(cell)) return true;
  return MAC_ROMAN_IN_A_NAME.test(cell) || (namesWithCapitals && MAC_ROMAN_CAPITAL_READ_AS_SMALL.test(cell));
}

/** TS-254: whether any cell in the file has a sign of windows-1252 text (WINDOWS_LETTERS). */
export function hasWindowsLetters(rows: string[][]): boolean {
  return rows.some((row) => row.some((cell) => WINDOWS_LETTERS.test(cell)));
}

/** TS-243: whether at least as many name cells start with a capital as with a small letter. */
function namesStartWithCapitals(rows: string[][], nameColumns: number[]): boolean {
  let capital = 0;
  let small = 0;
  for (const row of rows) {
    for (const c of nameColumns) {
      const first = row[c]?.trim().charAt(0) ?? "";
      if (/\p{Lu}/u.test(first)) capital++;
      else if (/\p{Ll}/u.test(first)) small++;
    }
  }
  return capital >= small;
}

/**
 * TS-210: the first cell an import uses that looks like the older Mac format, or null. `columns` are
 * the mapped columns' indexes; `nameColumns` the ones holding names (TS-233: first and last name
 * only -- "Bride’s college friends" in Household is real Windows text). Only for a file read as windows-1252 -- UTF-8 and UTF-16 files are read exactly.
 */
export function findMacRomanCell(
  rows: string[][],
  columns: number[],
  nameColumns: number[]
): { rowNumber: number; column: number } | null {
  const capitals = namesStartWithCapitals(rows, nameColumns);
  // TS-254: every cell counts here, imported or not ("café" in a notes column).
  const windowsFile = hasWindowsLetters(rows);
  for (let r = 0; r < rows.length; r++) {
    for (const c of columns) {
      const cell = rows[r][c];
      if (cell && looksLikeMacRoman(cell, nameColumns.includes(c), capitals, windowsFile)) return { rowNumber: r + 1, column: c };
    }
  }
  return null;
}

// TS-190: text that already holds the "couldn't read this character" mark (U+FFFD) lost letters
// before it reached Seatwise -- importing it would save the marks in guests' names.
export const UNREADABLE_CHARACTERS_MESSAGE =
  "This file has characters that couldn't be read — save it as 'CSV UTF-8' and choose it again.";

export function hasUnreadableCharacters(text: string): boolean {
  return text.includes("�");
}

/**
 * TS-198: one import cell that holds the U+FFFD mark. Only the cells an import uses are checked (and
 * not one equal to what the guest already has) -- a guest's own RSVP note in the export used to make
 * the whole file refused.
 */
export function unreadableCellMessage(label: string): string {
  return `${label} has characters that couldn't be read (shown as �) — retype them, or save the file as 'CSV UTF-8' and choose it again.`;
}
