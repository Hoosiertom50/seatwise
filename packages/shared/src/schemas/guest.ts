import { z } from "zod";

export const guestTierEnum = z.enum(["VIP", "FAMILY", "FRIEND", "PLUS_ONE", "OTHER"]);
export type GuestTier = z.infer<typeof guestTierEnum>;

export const rsvpStatusEnum = z.enum(["PENDING", "CONFIRMED", "DECLINED"]);
export type RsvpStatus = z.infer<typeof rsvpStatusEnum>;

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
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  partyName: z.string().max(200).optional().nullable(),
  headcount: z.number().int().min(1).max(20).default(1),
  tier: guestTierEnum.default("OTHER"),
  rsvpStatus: rsvpStatusEnum.default("PENDING"),
  requiresAccessibleTable: z.boolean().default(false),
  isLocked: z.boolean().default(false),
  dayOfAttendance: dayOfAttendanceEnum.default("ATTENDING"),
  notes: z.string().max(2000).optional().nullable(),
  side: guestSideEnum.default("BOTH"),
  ageCategory: ageCategoryEnum.default("ADULT"),
});
export type CreateGuestInput = z.infer<typeof createGuestSchema>;

export const updateGuestSchema = createGuestSchema.partial();
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
  createdAt: string;
  updatedAt: string;
}
