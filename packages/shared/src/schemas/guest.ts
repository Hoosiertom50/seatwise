import { z } from "zod";
// TS-180: free text refuses hidden control characters (see ../safe-text).
import { safeText } from "../safe-text";
import { FIELD_LIMITS } from "../field-limits";
import { expectedRevisionField } from "./common";
import { PERSON_NAME_PATTERN, PERSON_NAME_MESSAGE, looksLikeWebAddress, NO_WEB_ADDRESS_MESSAGE, hasMixedScriptWord, NO_MIXED_SCRIPT_MESSAGE } from "../validation";

export const guestTierEnum = z.enum(["VIP", "FAMILY", "FRIEND", "PLUS_ONE", "OTHER"]);
export type GuestTier = z.infer<typeof guestTierEnum>;

export const rsvpStatusEnum = z.enum(["PENDING", "CONFIRMED", "DECLINED"]);
export type RsvpStatus = z.infer<typeof rsvpStatusEnum>;

// TS-96: how these values read on screen. The stored/API values above stay exactly as they are --
// only the wording a planner sees changes (it used to be the raw enum: "PLUS ONE", "PENDING").
export const GUEST_TIER_LABELS: Record<GuestTier, string> = {
  VIP: "VIP",
  FAMILY: "Family",
  FRIEND: "Friend",
  PLUS_ONE: "Plus-one",
  OTHER: "Other",
};

export const RSVP_STATUS_LABELS: Record<RsvpStatus, string> = {
  // Not "Attending": that word already means Day-of mode's separate attendance status.
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  DECLINED: "Declined",
};

// FR-8.1: distinct from rsvpStatus — the same-day, freely-flippable "are they actually here"
// signal used by Day-Of Mode, independent of whatever they RSVP'd weeks earlier.
export const dayOfAttendanceEnum = z.enum(["ATTENDING", "NOT_ATTENDING"]);
export type DayOfAttendance = z.infer<typeof dayOfAttendanceEnum>;

// FR-3.4: which side of the wedding a guest belongs to. BOTH (the default) never counts toward
// either side for Side-Mixing purposes.
export const guestSideEnum = z.enum(["BRIDE", "GROOM", "BOTH"]);
export type GuestSide = z.infer<typeof guestSideEnum>;

// FR-3.7: lets a Purpose table's Age Category criterion (e.g. "Kids' Table") mean something --
// always a soft-preference input for generation, never a hard rule of its own.
export const ageCategoryEnum = z.enum(["ADULT", "CHILD", "INFANT"]);
export type AgeCategory = z.infer<typeof ageCategoryEnum>;

export const createGuestSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, "First name is required")
    .max(FIELD_LIMITS.personName)
    .regex(PERSON_NAME_PATTERN, PERSON_NAME_MESSAGE)
    // TS-163: a guest's name goes into their RSVP email, so -- like a planner's name (TS-156) -- it
    // can't read as a web address that the email app would turn into a link.
    .refine((v) => !looksLikeWebAddress(v), NO_WEB_ADDRESS_MESSAGE)
    // TS-178: nor mix look-alike letters from different alphabets in one word.
    .refine((v) => !hasMixedScriptWord(v), NO_MIXED_SCRIPT_MESSAGE),
  lastName: z
    .string()
    .trim()
    .min(1, "Last name is required")
    .max(FIELD_LIMITS.personName)
    .regex(PERSON_NAME_PATTERN, PERSON_NAME_MESSAGE)
    .refine((v) => !looksLikeWebAddress(v), NO_WEB_ADDRESS_MESSAGE)
    .refine((v) => !hasMixedScriptWord(v), NO_MIXED_SCRIPT_MESSAGE),
  partyName: safeText(FIELD_LIMITS.partyName).optional().nullable(),
  headcount: z.number().int().min(1).max(20).default(1),
  tier: guestTierEnum.default("OTHER"),
  rsvpStatus: rsvpStatusEnum.default("PENDING"),
  requiresAccessibleTable: z.boolean().default(false),
  isLocked: z.boolean().default(false),
  dayOfAttendance: dayOfAttendanceEnum.default("ATTENDING"),
  notes: safeText(FIELD_LIMITS.guestNotes, { multiline: true }).optional().nullable(),
  side: guestSideEnum.default("BOTH"),
  ageCategory: ageCategoryEnum.default("ADULT"),
  // TS-17 (FR-12.4): optional -- lets a planner send/resend this guest their own RSVP link. An
  // empty string (a form field left blank) is treated the same as omitting it entirely, not as an
  // invalid email.
  email: z
    .union([z.string().trim().max(FIELD_LIMITS.email).email("Not a valid email address"), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === "" ? null : v)),
  // TS-17 (FR-12.1): free-text "who's coming with you", only meaningful when headcount > 1.
  plusOneNames: safeText(FIELD_LIMITS.plusOneNames, { multiline: true }).optional().nullable(),
});
export type CreateGuestInput = z.infer<typeof createGuestSchema>;

// FR-7.7, extended to guests: every edit accepts the revision the client last saw, so the server
// can detect a save that landed on top of a newer one instead of silently overwriting it.
// TS-174: bounded to what the database can store (see ./common).

export const updateGuestSchema = createGuestSchema.partial().extend({
  expectedRevision: expectedRevisionField,
});
export type UpdateGuestInput = z.infer<typeof updateGuestSchema>;

export interface GuestDTO {
  id: string;
  weddingId: string;
  firstName: string;
  lastName: string;
  partyName: string | null;
  headcount: number;
  tier: GuestTier;
  rsvpStatus: RsvpStatus;
  requiresAccessibleTable: boolean;
  isLocked: boolean;
  dayOfAttendance: DayOfAttendance;
  notes: string | null;
  // FR-3.4
  side: GuestSide;
  // FR-3.7
  ageCategory: AgeCategory;
  // FR-3.7a: the Restricted table this guest is a required member of, if any (null otherwise).
  requiredTableId: string | null;
  // TS-17 (FR-12.4): lets a planner actually deliver (or resend) this guest's own RSVP link.
  // Deliberately NOT the raw rsvpToken itself -- see the dedicated rsvp-link endpoint for that.
  email: string | null;
  // TS-17 (FR-12.1): free-text "who's coming with you", only meaningful when headcount > 1.
  plusOneNames: string | null;
  // TS-17 (FR-12.4): set only by the guest's own public RSVP submission -- null means "hasn't
  // responded via their link yet" (independent of rsvpStatus, which a planner can also set directly).
  rsvpRespondedAt: string | null;
  // TS-107: the guest's own note from their RSVP form -- read-only to the planner, and separate
  // from `notes`, which is the planner's own and is never shown to the guest.
  rsvpNotes: string | null;
  createdAt: string;
  updatedAt: string;
  // FR-7.7: an optimistic-concurrency counter -- send this back as expectedRevision on an edit to
  // this guest so the server can detect and refuse a save based on stale data.
  revision: number;
}
