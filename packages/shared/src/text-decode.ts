// TS-190 (Tom's decision): a guest file saved by Excel on Windows as plain "CSV" isn't UTF-8 -- it
// uses the older Windows encoding (windows-1252), so "Müller" came through as "M�ller". The file's
// bytes are read as UTF-8 when they are valid UTF-8, and as windows-1252 otherwise.
// TS-198: a file that starts with a UTF-16 byte-order mark (Excel's "Unicode Text", some Google
// and Numbers exports) is read as UTF-16. And a file saved in the older Mac encoding (Mac Roman),
// which windows-1252 would turn into "RenŽe" or "MŸller", is refused with the "save it as CSV
// UTF-8" message rather than imported with the wrong letters.
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(view);
  }
  if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(view);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    const text = new TextDecoder("windows-1252").decode(view);
    if (looksLikeMacRoman(text)) throw new CsvEncodingError(MAC_ENCODING_MESSAGE);
    return text;
  }
}

/** TS-198: a file read as windows-1252 whose letters show it was really saved in the older Mac encoding. */
export class CsvEncodingError extends Error {}

export const MAC_ENCODING_MESSAGE =
  "Some letters in this file couldn't be read correctly (it looks like an older Mac format) — save it as 'CSV UTF-8' and choose it again.";

// TS-198: the characters windows-1252 shows for Mac Roman's accented letters -- Ž is é, Ÿ is ü, ƒ is
// É, Š is ä, š is ö, Œ is å, ‡ is á, ˆ is à, ‰ is â, † is Ü, ™ is ô, ž is û, ‹ is ã, › is õ, – is ñ,
// — is ó, and the bytes windows-1252 leaves undefined (Å, ç, è, ê, ù). Real windows-1252 text
// almost never has one of them right after a letter and followed by another letter (or, for Ž --
// é -- at the end of a word, as in "JosŽ"). Curly quotes (Mac í, ì, î, ë) are left out: "O’Brien"
// is a real name.
const MAC_ROMAN_LOOKALIKES = "ŽŸƒŠšŒ‡ˆ‰†™ž‹›–—\u0081\u008d\u008f\u0090\u009d";
const MAC_ROMAN_IN_A_WORD = new RegExp(
  `\\p{L}[${MAC_ROMAN_LOOKALIKES}]\\p{L}|\\p{L}Ž(?!\\p{L})`,
  "u"
);

function looksLikeMacRoman(text: string): boolean {
  return MAC_ROMAN_IN_A_WORD.test(text);
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
