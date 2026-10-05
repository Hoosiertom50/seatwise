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
export const WEB_ADDRESS_LIKE = /[\p{L}\p{N}]{2,}\.\p{L}{2,}/u;
export const NO_WEB_ADDRESS_MESSAGE = "Can't look like a web address";
export function looksLikeWebAddress(value: string): boolean {
  return WEB_ADDRESS_LIKE.test(value);
}

// TS-171: a wedding's name may hold numbers (a year, a date), but not a phone number -- the name
// goes into emails Seatwise sends, and a number to call is what a scam message needs. Seven or
// more digits in a row, ignoring spaces, hyphens and periods between them, is how a phone number
// looks; a year ("2026") or a short date ("10-5-26") doesn't reach that.
export const PHONE_NUMBER_LIKE = /\p{Nd}(?:[ .-]*\p{Nd}){6,}/u;
export const NO_PHONE_NUMBER_MESSAGE = "Can't contain a long run of digits, like a phone number (7 or more)";
export function looksLikePhoneNumber(value: string): boolean {
  return PHONE_NUMBER_LIKE.test(value);
}
