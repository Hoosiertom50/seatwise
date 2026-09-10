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
