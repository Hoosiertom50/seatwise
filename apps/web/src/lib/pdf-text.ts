// TS-152: the PDF exports use pdf-lib's built-in Helvetica, which can only draw the Windows-1252
// ("WinAnsi") character set -- one guest named "Łukasz" or "Nguyễn" used to make every export for
// that wedding fail. Everything drawn now goes through toPdfText: characters the font has are kept
// exactly (é, ñ, ü, ø, ß ... are all in it); an accented letter it lacks becomes its plain letter
// ("ễ" -> "e"); a few letters with no accent to strip are spelled the usual way ("Ł" -> "L");
// anything else (other scripts, emoji) becomes "?". The export always succeeds.

const WIN_ANSI_EXTRAS = new Set(
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split("")
);

function inWinAnsi(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRAS.has(ch);
}

// Letters that don't decompose into "base letter + accent".
const SPELLED: Record<string, string> = {
  Ł: "L", ł: "l", Đ: "D", đ: "d", Ħ: "H", ħ: "h", ı: "i", Ŀ: "L", ŀ: "l", Ŧ: "T", ŧ: "t",
  Ŋ: "N", ŋ: "n", ĸ: "k", ſ: "s", Ə: "E", ə: "e",
};

export function toPdfText(text: string): string {
  let out = "";
  // Combine "e" + a separate accent mark into "é" first, so it can be kept as one letter.
  for (const ch of text.normalize("NFC")) {
    if (inWinAnsi(ch)) {
      out += ch;
      continue;
    }
    if (ch === "\t" || ch === "\n" || ch === "\r") {
      out += " ";
      continue;
    }
    if (SPELLED[ch]) {
      out += SPELLED[ch];
      continue;
    }
    const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
    if (base && [...base].every(inWinAnsi)) {
      out += base;
      continue;
    }
    // A lone combining mark (from a decomposed string) is simply dropped.
    if (/^\p{M}$/u.test(ch)) continue;
    out += "?";
  }
  return out;
}
