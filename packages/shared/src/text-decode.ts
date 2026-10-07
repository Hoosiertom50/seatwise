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
  if (oddZeros >= pairs * 0.9 && evenZeros === 0) return "utf-16le";
  if (evenZeros >= pairs * 0.9 && oddZeros === 0) return "utf-16be";
  return null;
}

/**
 * TS-210: whether the bytes hold a UTF-8 letter that windows-1252 would show as two or three odd
 * characters ("Ã©", "Ã±", "Å¡", "â€™"). Two-byte letters starting with C6-DF are left out: read as
 * windows-1252 they are a capital accented letter then a quote or dash ("É”"), which real text has.
 */
function hasUtf8LetterPairs(view: Uint8Array): boolean {
  const cont = (b: number | undefined) => b !== undefined && b >= 0x80 && b <= 0xbf;
  for (let i = 0; i < view.length; i++) {
    const b = view[i];
    if (b >= 0xc2 && b <= 0xc5 && cont(view[i + 1])) return true;
    if (b >= 0xe0 && b <= 0xef && cont(view[i + 1]) && cont(view[i + 2])) return true;
    if (b >= 0xf0 && b <= 0xf4 && cont(view[i + 1]) && cont(view[i + 2]) && cont(view[i + 3])) return true;
  }
  return false;
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
// ("ƒloise" for Éloise, "‡ngel" for Ángel). "Željko Žižek" and "HAŸ-LES-ROSES" are still fine.
const MAC_ROMAN_NOT_LETTERS_AT_START = "ƒ‡ˆ‰†‹›";
const MAC_ROMAN_IN_A_WORD = new RegExp(
  `\\p{L}[${MAC_ROMAN_NOT_LETTERS}]\\p{L}|\\p{Ll}[ŽŠŒŸ]|\\p{Lu}[ŽŠŒŸ]\\p{Ll}|(?<!\\p{L})[${MAC_ROMAN_NOT_LETTERS_AT_START}]\\p{L}`,
  "u"
);
const MAC_ROMAN_IN_A_NAME = /\p{Ll}[’‘]\p{Ll}|\p{L}[¿§]/u;

/** TS-210: whether one cell (read as windows-1252) looks like it was saved in the older Mac format. */
export function looksLikeMacRoman(cell: string, isName = false): boolean {
  return MAC_ROMAN_IN_A_WORD.test(cell) || (isName && MAC_ROMAN_IN_A_NAME.test(cell));
}

/**
 * TS-210: the first cell an import uses that looks like the older Mac format, or null. `columns` are
 * the mapped columns' indexes; `nameColumns` the ones holding names (first/last name, household,
 * plus-ones). Only for a file read as windows-1252 -- UTF-8 and UTF-16 files are read exactly.
 */
export function findMacRomanCell(
  rows: string[][],
  columns: number[],
  nameColumns: number[]
): { rowNumber: number; column: number } | null {
  for (let r = 0; r < rows.length; r++) {
    for (const c of columns) {
      const cell = rows[r][c];
      if (cell && looksLikeMacRoman(cell, nameColumns.includes(c))) return { rowNumber: r + 1, column: c };
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
