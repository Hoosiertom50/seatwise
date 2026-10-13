// Name-field character validation (planner-reported UX gap, 2026-09-10 -- no ticket, a direct
// ask after noticing name fields would silently accept digits/symbols/emoji). This is an
// allowlist wide enough to admit how real names actually look -- accented letters (José,
// François), apostrophes (O'Brien), hyphens (Smith-Jones), periods (initials, "Jr."/"St.") --
// rather than a naive "letters only" rule that would reject perfectly real names. It exists only
// to catch the actually-nonsensical case a planner flagged, not to gatekeep what a "valid" name
// looks like.
//
// \p{L} = any Unicode letter (covers non-Latin scripts, not just accented Latin); \p{M} = the
// combining marks some accented characters decompose into. Requires the first character to be a
// letter so a name can't be just "-" or "'" on its own (the field's own .min(1)/.trim() already
// rejects blank/whitespace-only separately).
export const PERSON_NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u;
export const PERSON_NAME_MESSAGE =
  "Can only contain letters, spaces, hyphens, apostrophes, and periods";

// TS-243: Word, Outlook and the iPhone's Smart Punctuation type a curly apostrophe ("O’Brien"),
// and copied text can hold a no-break space -- both used to be refused as "can only contain
// letters...". Before the name rules run, ’ ‘ ʼ become a plain ' and a no-break space becomes a
// space; the plain form is what's saved. (One character for one, so lengths don't change.)
// TS-262: and the name is put in its composed form (NFC): an "é" pasted as "e" plus a separate
// accent mark becomes the one letter "é", so a real accented name is saved the usual way. (That
// can make a name shorter; the length is checked after.)
export function normalizePersonName(value: string): string {
  return value.replace(/[’‘ʼ]/g, "'").replace(/ /g, " ").normalize("NFC");
}

// TS-262: some characters show nothing at all -- the combining grapheme joiner (U+034F), the
// variation selectors (U+FE00-FE0F, U+E0100-E01EF, U+180B-180F), zero-width spaces and joiners
// (U+200B-200D, U+2060, U+FEFF), the soft hyphen, the Hangul fillers. Put inside "evil.com" one hid
// it from the web-address check while the name still read "evil.com" in an email. A person's or a
// wedding's name can't hold them; real accents (José, Nguyễn, Ó Súilleabháin) are not among them.
const HIDDEN_CHARACTER = /[\p{Default_Ignorable_Code_Point}\p{Variation_Selector}]/u;
export const NO_HIDDEN_CHARACTERS_MESSAGE = "Can't contain hidden characters — retype it or paste it as plain text";
export function hasHiddenCharacters(value: string): boolean {
  return HIDDEN_CHARACTER.test(value);
}

// A wedding's name is a title, not a person's name -- "Alex & Jordan's Wedding", "Smith-Jones
// Wedding, Est. 2026" -- so this allowlist is deliberately wider than PERSON_NAME_PATTERN: it
// adds digits, ampersands, commas, and exclamation points on top of the same base set.
export const WEDDING_NAME_PATTERN = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} '&,.!-]*$/u;
export const WEDDING_NAME_MESSAGE =
  "Can only contain letters, numbers, spaces, and common punctuation ( ' & , . ! - )";

// TS-156: names (a planner's own, a wedding's) are put into emails Seatwise sends to other people,
// so they mustn't read as a web address ("Verify at evil.example"). Two or more letters/digits, a
// period, then two or more letters is how a domain looks; real names with initials ("J.R. Smith",
// "Est. 2026", "St. Clair") don't match.
//
// TS-178: that missed a few ways of writing one -- a name with hyphens just before the dot
// ("help-a.com"), a one-letter name ("x.com"), and spaces around the dot ("evil . com"), which
// some email apps still turn into a link. So there are now three checks:
// - no space around the dot: a part of two or more letters, digits or inner hyphens, a period,
//   then two or more letters ("J.R." and "A.B." are still initials);
// - a single letter or digit, a period, then one of the endings scam links commonly use ("x.com");
// - any part, then a dot with spaces around it (or the word "dot"), then one of a shorter list of
//   endings that aren't also name parts -- so "Ana B. De Souza", "J. Link" and "J. R. Smith" still
//   pass.
//
// TS-258: the ending could also be spelled out with spaces between its letters ("evil . c o m"),
// which reads as a web address once the spaces are taken out. The spaced-dot check now allows
// spaces between the ending's letters too; it still needs a dot (or "dot") and a whole ending
// after it, so "Lee . Kim", "St. Pierre" and "J. R. R. Smith" pass.
const DOMAIN_ENDINGS = "com|net|org|info|biz|io|co|ly|app|xyz|top|site|online|shop|store|link|click|live|club|vip|icu|ru|cn|tk|gg";
const SPACED_DOMAIN_ENDINGS = "com|net|org|info|biz|xyz|site|online|shop|click|icu|ru|cn";
// TS-265: and the other characters that look like a period or a raised dot -- some are letters
// (U+A4F8 Lisu, U+A78F Latin sinological dot, U+1427 Canadian syllabics), so "paypalꓸcom" passed
// every name rule. Fullwidth, small and other compatibility forms of a period (U+FE52, U+2024...)
// are folded to a plain one before the check (see looksLikeWebAddress).
const DOT = String.raw`[.\u3002\uFF0E\uFF61\u00B7\u0387\u0660\u06F0\u0701\u0702\u1427\u16EB\u2022\u2024\u2027\u2219\u22C5\u2E31\u30FB\uA4F8\uA60E\uA78F\uFE52\uFF65\u{10101}\u{10A50}]`;
// PR #114 review: before any other ending, only a real full stop counts -- a middle dot is how
// Japanese ("\u30B8\u30E7\u30F3\u30FB\u30B9\u30DF\u30B9") and Catalan ("Gal\u00B7la") names are written, so the middle dots above
// count only before the endings scam links use.
const FULL_STOP = String.raw`[.\u3002\uFF0E\uFF61\u0701\u0702\u2024\uA60E\uFE52\u{10A50}]`;
// TS-258: "com" becomes c\s*o\s*m, so "c o m" is caught as well.
const SPACED_LETTER_ENDINGS = SPACED_DOMAIN_ENDINGS.split("|")
  .map((ending) => [...ending].join(String.raw`\s*`))
  .join("|");
export const WEB_ADDRESS_LIKE = new RegExp(
  [
    // TS-265: hyphens just before the dot too ("evil-.com", "x-.com"). And it starts only where a
    // run of letters, digits and hyphens starts (anything it found from inside a run it finds from
    // the run's start), so a long name is read once rather than once from every letter -- a
    // 4,000-character run of fullwidth letters took half a second.
    String.raw`(?<![\p{L}\p{N}-])-*[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}-]${FULL_STOP}\p{L}{2,}`,
    String.raw`[\p{L}\p{N}]-*${DOT}(?:${DOMAIN_ENDINGS})(?![\p{L}\p{N}])`,
    String.raw`[\p{L}\p{N}](?:\s*${DOT}\s*|\s+dot\s+)(?:${SPACED_LETTER_ENDINGS})(?![\p{L}\p{N}])`,
  ].join("|"),
  "iu"
);
export const NO_WEB_ADDRESS_MESSAGE = "Can't look like a web address";
// TS-262: the check also runs on a copy with accent marks and hidden characters taken out -- an
// invisible mark inside "com" ("evil.c" + U+034F + "om") stopped the match, though it still reads
// (and can link) as "evil.com". Taking characters out only joins letters up, so the copy never
// misses what the plain check finds.
// TS-265: the copy took out every mark, and in Tamil, Hindi and other Indic scripts the vowels
// after a letter are marks -- so an initial written without a space ("இரா.செழியன்", "श्री.रामचंद्र",
// "आर.किरण") joined up into "letters.letters" and was refused. Now a mark is kept when it belongs to
// the letter's own script and follows a letter of a script other than Latin, Greek or Cyrillic (a
// Tamil vowel after a Tamil letter); accents (José, Nguyễn) and marks put after a Latin letter or a
// dot are still taken out. And the copy is now in its compatibility form (NFKC), so fullwidth,
// math, superscript and small forms read as the plain letters and dots they look like ("x.ｃｏｍ",
// "evil . ｃｏｍ", "x.ᶜᵒᵐ", "evil﹒com").
const HIDDEN_CHARACTERS = /[\p{Default_Ignorable_Code_Point}\p{Variation_Selector}]/gu;
const LETTER_AND_MARKS = /(\p{L}?)(\p{M}+)/gu;
const KEEPS_ITS_MARKS = /^(?![\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{L}$/u;
const SCRIPT_OWN_MARK = /(?!\p{Script=Inherited})\p{M}/gu;
// TS-265: marks drawn as a dot below or beside a letter -- "evil" + U+0323 + "com" reads as
// "evil.com" (saved as "eviḷcom"). Only checked against the endings scam links use, right after
// (see DOTTED_ENDING), since Vietnamese and transliterated names have letters with a dot below
// ("Thịnh", "Ngọc", "Kṛṣṇa").
const DOT_LIKE_MARK = /[\u0323\u0358\u05C5\u065C\u093C\u09BC\u0A3C\u0ABC\u0B3C\u0CBC\u{1D16D}]/u;
const DOTTED_ENDING = new RegExp(String.raw`[\p{L}\p{N}]-*${DOT}(?:${DOMAIN_ENDINGS})(?![\p{L}\p{N}])`, "iu");

/** TS-265: the copies of `value` the web-address and phone checks also look at (see above). */
function foldedCopies(value: string): { plain: string; dotted: string } {
  const decomposed = value.normalize("NFKD").replace(HIDDEN_CHARACTERS, "");
  let dotted = "";
  let last = 0;
  let plain = "";
  for (const match of decomposed.matchAll(LETTER_AND_MARKS)) {
    const [whole, letter, marks] = match;
    const kept = KEEPS_ITS_MARKS.test(letter) ? marks.match(SCRIPT_OWN_MARK)?.join("") ?? "" : "";
    const before = decomposed.slice(last, match.index);
    plain += before + letter + kept;
    // PR #114 review: when a mark is drawn as a dot, the letter is followed by the dot alone -- a
    // kept mark (an Arabic or Devanagari dot after its own letter) sat between them and hid the ending.
    dotted += before + letter + (DOT_LIKE_MARK.test(marks) ? "." : kept);
    last = match.index + whole.length;
  }
  const rest = decomposed.slice(last);
  return { plain: (plain + rest).normalize("NFKC"), dotted: (dotted + rest).normalize("NFKC") };
}

export function looksLikeWebAddress(value: string): boolean {
  if (WEB_ADDRESS_LIKE.test(value)) return true;
  const { plain, dotted } = foldedCopies(value);
  return (plain !== value && WEB_ADDRESS_LIKE.test(plain)) || (dotted !== plain && DOTTED_ENDING.test(dotted));
}

// TS-171: a wedding's name may hold numbers (a year, a date), but not a phone number -- the name
// goes into emails Seatwise sends, and a number to call is what a scam message needs. Seven or
// more digits in a row, ignoring spaces, hyphens and periods between them, is how a phone number
// looks; a year ("2026") or a short date ("10-5-26") doesn't reach that.
//
// TS-178: commas, apostrophes, slashes, brackets, underscores and other dashes are ignored between
// the digits too ("800, 555, 1234" is still a number to call).
export const PHONE_NUMBER_LIKE = /\p{Nd}(?:[\s.,'’/()[\]_\u2010-\u2015-]*\p{Nd}){6,}/u;
export const NO_PHONE_NUMBER_MESSAGE = "Can't contain a long run of digits, like a phone number (7 or more)";
// TS-262: and, like the web-address check, on a copy without accent marks or hidden characters.
// TS-265: the same copy as the web-address check, so superscript digits ("⁸⁰⁰⁵⁵⁵¹²³⁴") count too.
export function looksLikePhoneNumber(value: string): boolean {
  if (PHONE_NUMBER_LIKE.test(value)) return true;
  const { plain } = foldedCopies(value);
  return plain !== value && PHONE_NUMBER_LIKE.test(plain);
}

// TS-178: a word written partly in Latin letters and partly in look-alike Cyrillic or Greek ones
// ("Pаypal" with a Cyrillic "а") is made to pass for something it isn't. Real names in those
// alphabets are welcome -- only one word mixing them with Latin letters is refused. Words are
// split at anything that isn't a letter, so "Ivanova-Иванова" (two words) is fine.
export const NO_MIXED_SCRIPT_MESSAGE = "Can't mix letters from different alphabets in one word";
export function hasMixedScriptWord(value: string): boolean {
  return value
    .split(/[^\p{L}\p{M}]+/u)
    .some((word) => /\p{Script=Latin}/u.test(word) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word));
}