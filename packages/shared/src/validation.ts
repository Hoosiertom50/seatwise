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
const DOMAIN_ENDINGS = "com|net|org|info|biz|io|co|ly|app|xyz|top|site|online|shop|store|link|click|live|club|vip|icu|ru|cn|tk|gg";
const SPACED_DOMAIN_ENDINGS = "com|net|org|info|biz|xyz|site|online|shop|click|icu|ru|cn";
const DOT = String.raw`[.\u3002\uFF0E\uFF61]`; // a period, or one of the look-alike dots
export const WEB_ADDRESS_LIKE = new RegExp(
  [
    String.raw`[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}]${DOT}\p{L}{2,}`,
    String.raw`[\p{L}\p{N}]${DOT}(?:${DOMAIN_ENDINGS})(?![\p{L}\p{N}])`,
    String.raw`[\p{L}\p{N}](?:\s*${DOT}\s*|\s+dot\s+)(?:${SPACED_DOMAIN_ENDINGS})(?![\p{L}\p{N}])`,
  ].join("|"),
  "iu"
);
export const NO_WEB_ADDRESS_MESSAGE = "Can't look like a web address";
export function looksLikeWebAddress(value: string): boolean {
  return WEB_ADDRESS_LIKE.test(value);
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
export function looksLikePhoneNumber(value: string): boolean {
  return PHONE_NUMBER_LIKE.test(value);
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