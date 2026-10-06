// FR-2.4/2.4a: reading one row of a guest import file -- what each mapped cell says, or why it
// can't be imported. Used by the import's preview and commit (packages/db guest-import.ts).
// TS-198: moved here from the database package unchanged apart from the TS-198 notes below, so the
// rules can be unit tested without a database.
import { guestTierEnum, rsvpStatusEnum, dayOfAttendanceEnum, ageCategoryEnum } from "./schemas/guest";
import type { GuestImportMapping, GuestImportRowPreview } from "./schemas/guest-import";
import {
  PERSON_NAME_PATTERN,
  PERSON_NAME_MESSAGE,
  looksLikeWebAddress,
  NO_WEB_ADDRESS_MESSAGE,
  hasMixedScriptWord,
  NO_MIXED_SCRIPT_MESSAGE,
} from "./validation";
import { parseGuestSide } from "./guest-side";
import { hasForbiddenControlCharacter, CONTROL_CHARACTER_MESSAGE, LINE_BREAK_MESSAGE } from "./safe-text";
import { hasUnreadableCharacters, unreadableCellMessage } from "./text-decode";
import { sameImportText, type GuestImportCurrentValues } from "./guest-import-compare";

// A field that's nullable on the guest record (partyName, notes) needs a way to say "clear this
// value" that's distinct from "this cell is blank, leave the existing value alone" (FR-2.4a) --
// this literal token is that signal.
// TS-180: "[CLEAR]" (any case) is the documented token now. Plain CLEAR still works, but only in
// capitals -- a household really called "Clear" used to be wiped instead of saved.
export function isClearToken(value: string): boolean {
  return value === "CLEAR" || value.toUpperCase() === "[CLEAR]";
}

// TS-180: the same hidden-character rule as the app's forms (see safeText), for free-text cells.
// TS-190: the length is counted after Windows line endings become plain ones (what's saved), and a
// single-line value (the household) can't hold a line break -- the same rules as safeText.
// TS-198: nor the "couldn't read this character" mark (U+FFFD), with a message that says why.
function checkFreeText(label: string, value: string, max: number, errors: string[], singleLine = false): boolean {
  if (value.replace(/\r\n/g, "\n").length > max) {
    errors.push(`${label} can be at most ${max} characters.`);
    return false;
  }
  if (hasForbiddenControlCharacter(value)) {
    errors.push(`${label}: ${CONTROL_CHARACTER_MESSAGE.toLowerCase()}.`);
    return false;
  }
  if (singleLine && /[\r\n]/.test(value)) {
    errors.push(`${label}: ${LINE_BREAK_MESSAGE.toLowerCase()}.`);
    return false;
  }
  if (hasUnreadableCharacters(value)) {
    errors.push(unreadableCellMessage(label));
    return false;
  }
  return true;
}

function normalizeEnumValue(raw: string, allowed: readonly string[]): string | null {
  const normalized = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return allowed.includes(normalized) ? normalized : null;
}

/** The text fields a cell can leave exactly as the guest already has them (see `keptAsIs`). */
export type GuestImportKeptField = "firstName" | "lastName" | "partyName" | "notes" | "plusOneNames";

/**
 * One import row. `current` is the guest the row updates (when its Guest ID is one of the wedding's
 * guests).
 *
 * TS-198: a text cell (a name, the household, notes, plus-ones) that says exactly what the guest
 * already has is taken as it is, without checking it again -- a value saved before a newer rule
 * (or a household literally called "CLEAR", or a note holding the U+FFFD mark) used to make an
 * untouched export impossible to re-import. `keptAsIs` lists those fields, so the commit can tell
 * if one of them changed in the meantime.
 */
export function parseGuestImportRow(
  cells: string[],
  headers: string[],
  mapping: GuestImportMapping,
  sideLabels: { sideLabel1: string; sideLabel2: string },
  current?: GuestImportCurrentValues
): { errors: string[]; data: GuestImportRowPreview; keptAsIs: GuestImportKeptField[] } {
  const errors: string[] = [];
  const data: GuestImportRowPreview = {};
  const keptAsIs: GuestImportKeptField[] = [];

  function rawCellFor(field: keyof GuestImportMapping): string | undefined {
    const header = mapping[field];
    if (!header) return undefined;
    const idx = headers.indexOf(header);
    if (idx === -1) return undefined;
    return cells[idx];
  }
  function cellFor(field: keyof GuestImportMapping): string | undefined {
    return rawCellFor(field)?.trim();
  }
  // TS-198: whether this cell says exactly what the guest already has (see above).
  function keeps(field: GuestImportKeptField): boolean {
    const raw = rawCellFor(field);
    if (!current || raw === undefined || raw.trim() === "") return false;
    const stored = current[field];
    if (stored === null || !sameImportText(raw, stored)) return false;
    (data as Record<string, unknown>)[field] = stored;
    keptAsIs.push(field);
    return true;
  }

  function checkName(label: string, value: string): boolean {
    // Same 100-char cap and character allowlist as the single-guest add/edit form (createGuestSchema)
    // -- this bulk path used to skip both, so a CSV could smuggle in a name the regular form would
    // have rejected outright.
    if (value.length > 100) {
      errors.push(`${label} "${value}" is too long (100 characters max).`);
    } else if (hasUnreadableCharacters(value)) {
      // TS-198: say why, rather than "can only contain letters".
      errors.push(unreadableCellMessage(`${label} "${value}"`));
    } else if (!PERSON_NAME_PATTERN.test(value)) {
      errors.push(`${label} "${value}" is invalid: ${PERSON_NAME_MESSAGE.toLowerCase()}.`);
    } else if (looksLikeWebAddress(value)) {
      // TS-168: same rule as adding a guest by hand (names go into emails).
      errors.push(`${label} "${value}" is invalid: ${NO_WEB_ADDRESS_MESSAGE.toLowerCase()}.`);
    } else if (hasMixedScriptWord(value)) {
      // TS-178: same rule as adding a guest by hand.
      errors.push(`${label} "${value}" is invalid: ${NO_MIXED_SCRIPT_MESSAGE.toLowerCase()}.`);
    } else {
      return true;
    }
    return false;
  }

  const firstName = cellFor("firstName");
  const lastName = cellFor("lastName");
  if (!firstName || !lastName) {
    errors.push("Missing required name (first and last name are both required).");
  } else {
    if (!keeps("firstName") && checkName("First name", firstName)) data.firstName = firstName;
    if (!keeps("lastName") && checkName("Last name", lastName)) data.lastName = lastName;
  }

  const partyName = cellFor("partyName");
  if (partyName !== undefined && partyName !== "" && !keeps("partyName")) {
    // TS-152: the same limit as adding a guest by hand.
    if (isClearToken(partyName)) data.partyName = null;
    else if (checkFreeText("Household name", partyName, 200, errors, true)) data.partyName = partyName;
  }

  const headcountRaw = cellFor("headcount");
  if (headcountRaw !== undefined && headcountRaw !== "") {
    const value = Number(headcountRaw);
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      errors.push(`Headcount must be a whole number between 1 and 20 (got "${headcountRaw}").`);
    } else {
      data.headcount = value;
    }
  }

  const tierRaw = cellFor("tier");
  if (tierRaw !== undefined && tierRaw !== "") {
    const normalized = normalizeEnumValue(tierRaw, guestTierEnum.options);
    if (!normalized) {
      errors.push(`Tier "${tierRaw}" isn't one of ${guestTierEnum.options.join(", ")}.`);
    } else {
      data.tier = normalized;
    }
  }

  const rsvpRaw = cellFor("rsvpStatus");
  if (rsvpRaw !== undefined && rsvpRaw !== "") {
    const normalized = normalizeEnumValue(rsvpRaw, rsvpStatusEnum.options);
    if (!normalized) {
      errors.push(`RSVP status "${rsvpRaw}" isn't one of ${rsvpStatusEnum.options.join(", ")}.`);
    } else {
      data.rsvpStatus = normalized;
    }
  }

  const accessibleRaw = cellFor("requiresAccessibleTable");
  if (accessibleRaw !== undefined && accessibleRaw !== "") {
    const normalized = accessibleRaw.toLowerCase();
    if (["yes", "y", "true", "1"].includes(normalized)) data.requiresAccessibleTable = true;
    else if (["no", "n", "false", "0"].includes(normalized)) data.requiresAccessibleTable = false;
    else errors.push(`"Requires accessible table" must be yes/no (got "${accessibleRaw}").`);
  }

  const dayOfRaw = cellFor("dayOfAttendance");
  if (dayOfRaw !== undefined && dayOfRaw !== "") {
    const normalized = normalizeEnumValue(dayOfRaw, dayOfAttendanceEnum.options);
    if (!normalized) {
      errors.push(`Attendance "${dayOfRaw}" isn't one of ${dayOfAttendanceEnum.options.join(", ")}.`);
    } else {
      data.dayOfAttendance = normalized;
    }
  }

  // TS-177: the wedding's own side names (what the Guests tab tells planners to use) as well as
  // "Both" and the stored BRIDE / GROOM -- see parseGuestSide.
  const sideRaw = cellFor("side");
  if (sideRaw !== undefined && sideRaw !== "") {
    const side = parseGuestSide(sideRaw, sideLabels.sideLabel1, sideLabels.sideLabel2);
    if ("error" in side) errors.push(side.error);
    else data.side = side.side;
  }

  const ageCategoryRaw = cellFor("ageCategory");
  if (ageCategoryRaw !== undefined && ageCategoryRaw !== "") {
    const normalized = normalizeEnumValue(ageCategoryRaw, ageCategoryEnum.options);
    if (!normalized) {
      errors.push(`Age category "${ageCategoryRaw}" isn't one of ${ageCategoryEnum.options.join(", ")}.`);
    } else {
      data.ageCategory = normalized;
    }
  }

  const notes = cellFor("notes");
  if (notes !== undefined && notes !== "" && !keeps("notes")) {
    if (isClearToken(notes)) data.notes = null;
    else if (checkFreeText("Notes", notes, 2000, errors)) data.notes = notes.replace(/\r\n/g, "\n");
  }

  // TS-180: the export's "Plus-ones" column -- who's coming with the guest.
  const plusOneNames = cellFor("plusOneNames");
  if (plusOneNames !== undefined && plusOneNames !== "" && !keeps("plusOneNames")) {
    if (isClearToken(plusOneNames)) data.plusOneNames = null;
    else if (checkFreeText("Plus-ones", plusOneNames, 500, errors)) data.plusOneNames = plusOneNames.replace(/\r\n/g, "\n");
  }

  return { errors, data, keptAsIs };
}
