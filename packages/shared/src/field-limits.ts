// TS-193: the most characters each text field takes, in one place. The server's checks (the zod
// schemas in ./schemas) and the screens (maxLength on every text box in apps/web) both read these,
// so typing stops at exactly the length the server accepts -- instead of someone typing a long
// note and only finding out it's too long when it fails to save. Change a limit here and both
// sides change together.
export const FIELD_LIMITS = {
  /** Any email address (the longest an address can be, RFC 5321). */
  email: 254,
  /** A password: bcrypt only uses the first 72 bytes (TS-163), so 72 is the most a box takes. */
  password: 72,
  /** A person's name: a planner's own name, a guest's first or last name, a walk-in's names. */
  personName: 100,
  weddingName: 200,
  venueName: 200,
  weddingNote: 2000,
  /** The two names the guest list sorts sides by ("Bride" / "Groom"). */
  sideLabel: 40,
  partyName: 200,
  guestNotes: 2000,
  /** "Who's coming with you" -- the planner's guest form and the guest's own RSVP. */
  plusOneNames: 500,
  rsvpNotes: 2000,
  tableLabel: 100,
  tablePurpose: 200,
  tablePurposeValue: 40,
  /** Quick-create's name for a set of tables ("Table" -> Table 1, Table 2, ...). */
  tableLabelPrefix: 50,
  templateName: 150,
  planVersionLabel: 100,
  timelineDescription: 300,
  /** A comment or a reply. */
  comment: 4000,
  vendorName: 200,
  vendorCategoryOther: 100,
  vendorContactName: 200,
  vendorContactPhone: 40,
  vendorContractNotes: 4000,
  /** Money typed as text ("1,500.00"); the amount itself is capped by the schemas in cents. */
  money: 20,
  /** Search and filter boxes -- never saved, but no reason to take a novel. */
  search: 100,
} as const;

export type FieldLimitName = keyof typeof FIELD_LIMITS;

/**
 * TS-193: a phone number for a vendor contact -- digits, spaces and + - ( ) . only, optionally
 * followed by an extension ("ext. 12", "ext 12" or "x12").
 *
 * TS-200: written so checking it takes time in step with the length, however long the value. It
 * used to be `^[0-9+().\-\s]*(\s*(ext\.?|x)\s*[0-9]+)?\s*$` (TS-198's version) -- spaces could
 * belong to either the first part or the extension's leading `\s*`, so a long run of spaces
 * followed by a wrong character was tried every possible way (time growing with the square of the
 * length). Spaces before "ext"/"x" already fit the first part, so that `\s*` is gone.
 * TS-214: the two are meant to accept the same values; long-input.test.mts checks that on 200,000
 * random values up to 40 characters long -- a strong check, not a proof.
 */
// TS-198: spaces after an extension ("ext. 12 ") are fine too -- the server trims them, and the
// box's HTML pattern below, which sees the untrimmed value, accepts them as well.
// TS-200: written so it can't backtrack on long input (no overlapping spaces before "ext").
export const CONTACT_PHONE_PATTERN = /^[0-9+().\-\s]*(?:(?:ext\.?|x)\s*[0-9]+\s*)?$/i;
export const CONTACT_PHONE_MESSAGE = "Use digits and + - ( ) . only (ext. allowed)";
/**
 * The same rule written for an HTML `pattern` attribute (browsers test it against the whole value,
 * with the `v` flag and no `i` flag -- hence the spelled-out letter cases and escapes).
 */
export const CONTACT_PHONE_HTML_PATTERN = "[0-9\\+\\(\\)\\.\\-\\s]*(\\s*([Ee][Xx][Tt]\\.?|[Xx])\\s*[0-9]+)?\\s*";

/** Whether a vendor contact phone (already trimmed) uses only the allowed characters. Blank is fine. */
export function isAllowedContactPhone(value: string): boolean {
  return CONTACT_PHONE_PATTERN.test(value);
}

/**
 * TS-198: the start of `text`, at most `max` characters long as the limits count them (UTF-16
 * units, like a form's maxLength), cut between whole characters -- an emoji is never split in half
 * (cutting by `slice` could leave half of one, which shows as a broken character).
 */
export function cutToLimit(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}
