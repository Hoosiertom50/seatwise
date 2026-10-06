import type { GuestImportRowPreview } from "./schemas/guest-import";

// TS-190: a guest as they are now, for telling which of an import row's values would change them.
// `notes` is the plain (decrypted) text.
export interface GuestImportCurrentValues {
  firstName: string;
  lastName: string;
  partyName: string | null;
  headcount: number;
  tier: string;
  rsvpStatus: string;
  requiresAccessibleTable: boolean;
  dayOfAttendance: string;
  side: string;
  ageCategory: string;
  notes: string | null;
  plusOneNames: string | null;
}

// The import trims every cell and saves Windows line endings as plain ones, and an empty value is
// the same as none -- so text is compared the same way.
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? "").replace(/\r\n/g, "\n").trim();
  return norm(a) === norm(b);
}

/**
 * TS-190: only the values in an import row that differ from the guest as they are now. A row that
 * comes back empty changes nothing, so it's left alone (not written, not counted as updated, and the
 * guest's revision isn't bumped) -- re-importing an untouched export used to "update" everyone.
 */
export function changedImportFields(p: GuestImportRowPreview, current: GuestImportCurrentValues): GuestImportRowPreview {
  const out: GuestImportRowPreview = {};
  if (p.firstName !== undefined && p.firstName !== current.firstName) out.firstName = p.firstName;
  if (p.lastName !== undefined && p.lastName !== current.lastName) out.lastName = p.lastName;
  if ("partyName" in p && !sameText(p.partyName, current.partyName)) out.partyName = p.partyName;
  if (p.headcount !== undefined && p.headcount !== current.headcount) out.headcount = p.headcount;
  if (p.tier !== undefined && p.tier !== current.tier) out.tier = p.tier;
  if (p.rsvpStatus !== undefined && p.rsvpStatus !== current.rsvpStatus) out.rsvpStatus = p.rsvpStatus;
  if (p.requiresAccessibleTable !== undefined && p.requiresAccessibleTable !== current.requiresAccessibleTable) {
    out.requiresAccessibleTable = p.requiresAccessibleTable;
  }
  if (p.dayOfAttendance !== undefined && p.dayOfAttendance !== current.dayOfAttendance) out.dayOfAttendance = p.dayOfAttendance;
  if (p.side !== undefined && p.side !== current.side) out.side = p.side;
  if (p.ageCategory !== undefined && p.ageCategory !== current.ageCategory) out.ageCategory = p.ageCategory;
  if ("notes" in p && !sameText(p.notes, current.notes)) out.notes = p.notes;
  if ("plusOneNames" in p && !sameText(p.plusOneNames, current.plusOneNames)) out.plusOneNames = p.plusOneNames;
  return out;
}

/** TS-190: whether an import row would leave the guest exactly as they are. */
export function importRowChangesNothing(p: GuestImportRowPreview, current: GuestImportCurrentValues): boolean {
  return Object.keys(changedImportFields(p, current)).length === 0;
}
