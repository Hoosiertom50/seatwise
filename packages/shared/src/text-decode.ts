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
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(view), encoding: "utf-8" };
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

/** TS-237: A1-BF in windows-1252 (the same as Latin-1) that aren't letters: ¡ ¢ £ « » ¿ … (not ª µ º). */
function isWindows1252Punctuation(b: number): boolean {
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
const MAC_ROMAN_IN_A_NAME = new RegExp(
  `\\p{Ll}[’‘]\\p{Ll}|\\p{L}[¿§]|(?<!\\p{L})[${MAC_ROMAN_NOT_LETTERS_AT_START}]\\p{L}|\\p{Ll}œ(?![ui])\\p{Ll}`,
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
 */
export function looksLikeMacRoman(cell: string, isName = false, namesWithCapitals = true): boolean {
  if (MAC_ROMAN_IN_A_WORD.test(cell)) return true;
  if (!isName) return false;
  return MAC_ROMAN_IN_A_NAME.test(cell) || (namesWithCapitals && MAC_ROMAN_CAPITAL_READ_AS_SMALL.test(cell));
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
  for (let r = 0; r < rows.length; r++) {
    for (const c of columns) {
      const cell = rows[r][c];
      if (cell && looksLikeMacRoman(cell, nameColumns.includes(c), capitals)) return { rowNumber: r + 1, column: c };
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
