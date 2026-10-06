// TS-190 (Tom's decision): a guest file saved by Excel on Windows as plain "CSV" isn't UTF-8 -- it
// uses the older Windows encoding (windows-1252), so "Müller" came through as "M�ller". The file's
// bytes are read as UTF-8 when they are valid UTF-8, and as windows-1252 otherwise.
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    return new TextDecoder("windows-1252").decode(view);
  }
}

// TS-190: text that already holds the "couldn't read this character" mark (U+FFFD) lost letters
// before it reached Seatwise -- importing it would save the marks in guests' names.
export const UNREADABLE_CHARACTERS_MESSAGE =
  "This file has characters that couldn't be read — save it as 'CSV UTF-8' and choose it again.";

export function hasUnreadableCharacters(text: string): boolean {
  return text.includes("�");
}
