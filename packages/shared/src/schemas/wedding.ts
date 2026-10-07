import { z } from "zod";
// TS-180: free text refuses hidden control characters (see ../safe-text).
import { safeText } from "../safe-text";
import { FIELD_LIMITS, cutToLimit } from "../field-limits";
import { calendarDateField, expectedRevisionField, lengthFirst } from "./common";
import {
  WEDDING_NAME_PATTERN,
  WEDDING_NAME_MESSAGE,
  looksLikeWebAddress,
  NO_WEB_ADDRESS_MESSAGE,
  looksLikePhoneNumber,
  NO_PHONE_NUMBER_MESSAGE,
  hasMixedScriptWord,
  NO_MIXED_SCRIPT_MESSAGE,
} from "../validation";

// TS-168: the rules for a wedding's name, wherever one is given (creating, renaming, copying).
// TS-200: the length is checked first, and a name that's too long goes no further (lengthFirst).
export const weddingNameField = lengthFirst(
  FIELD_LIMITS.weddingName,
  z
    .string()
    .min(1, "Wedding name is required")
    .regex(WEDDING_NAME_PATTERN, WEDDING_NAME_MESSAGE)
    // TS-156: the wedding name goes into RSVP and invite emails.
    .refine((v) => !looksLikeWebAddress(v), NO_WEB_ADDRESS_MESSAGE)
    // TS-171: nor can it carry a phone number.
    .refine((v) => !looksLikePhoneNumber(v), NO_PHONE_NUMBER_MESSAGE)
    // TS-178: nor mix look-alike letters from different alphabets in one word.
    .refine((v) => !hasMixedScriptWord(v), NO_MIXED_SCRIPT_MESSAGE)
);

/** TS-168: the default name for a copy -- within the length limit and the allowed characters. */
export function copiedWeddingName(original: string): string {
  const suffix = " - copy";
  // TS-214: cut between whole characters -- slice could split a character in half, and the copy
  // was then named with a broken character that the name rules refuse on the next save.
  return `${cutToLimit(original.trim(), FIELD_LIMITS.weddingName - suffix.length).trim()}${suffix}`;
}

/**
 * TS-214: a reason to ask before saving this RSVP cutoff, or null when it looks right. A cutoff
 * before today closes every guest's RSVP link (and stops RSVP emails) at once; one after the
 * wedding is almost always a slip in the year. Dates are "YYYY-MM-DD" (they compare as text).
 */
export function rsvpCutoffWarning(cutoff: string, today: string, eventDate: string | null): string | null {
  if (!cutoff) return null;
  if (cutoff < today) {
    return "That RSVP cutoff is before today — every guest's RSVP link closes as soon as it's saved, and RSVP emails stop going out.";
  }
  if (eventDate && cutoff > eventDate) {
    return "That RSVP cutoff is after the wedding date — guests could still answer after the day itself.";
  }
  return null;
}

// FR-3.4: how much generation weights table composition toward mixing the two sides. Always a
// soft preference — see packages/shared/src/seating-engine.ts.
export const sideMixingEnum = z.enum(["KEEP_SEPARATE", "BALANCED_MIX", "FULLY_MIXED"]);
export type SideMixing = z.infer<typeof sideMixingEnum>;

// TS-190: a guest's side is exported as the wedding's own name for it, or "Both" -- so a side named
// "Both", or two sides with the same name (in any case), can't be told apart when the file comes
// back, and guests' sides were changed on re-import.
export const SIDE_LABELS_MESSAGE = "Side names must be different from each other and from 'Both'.";

/** TS-190: whether these side names would mix up sides on re-import (see SIDE_LABELS_MESSAGE). */
export function sideLabelsClash(sideLabel1: string | null | undefined, sideLabel2: string | null | undefined): boolean {
  const a = sideLabel1?.trim().toLowerCase();
  const b = sideLabel2?.trim().toLowerCase();
  if (a === "both" || b === "both") return true;
  return !!a && !!b && a === b;
}

function checkSideLabels(data: { sideLabel1?: string | null; sideLabel2?: string | null }, ctx: z.RefinementCtx) {
  if (!sideLabelsClash(data.sideLabel1, data.sideLabel2)) return;
  const path = data.sideLabel1?.trim().toLowerCase() === "both" || data.sideLabel2 === undefined ? "sideLabel1" : "sideLabel2";
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: SIDE_LABELS_MESSAGE, path: [path] });
}

const weddingBaseSchema = z.object({
  // TS-171: the same rules as everywhere else a wedding is named (see weddingNameField).
  name: weddingNameField,
  // TS-174: a date the database can store (year 0000 used to be a server error).
  eventDate: calendarDateField.optional().nullable(),
  venueName: safeText(FIELD_LIMITS.venueName).optional().nullable(),
  // FR-1.3: "an optional note" -- always optional, blank is fine (AC: creating with the note left
  // blank saves with no error).
  note: safeText(FIELD_LIMITS.weddingNote, { multiline: true }).optional().nullable(),
  sideMixing: sideMixingEnum.default("BALANCED_MIX"),
  // FR-1.3a: this wedding's own name for each side (e.g. "Bride"/"Groom") -- a display label
  // only. Renaming never touches the underlying GuestSide value (BRIDE/GROOM/BOTH) stored on any
  // guest, so no guest, rule, or assignment is recreated or lost when these change.
  sideLabel1: safeText(FIELD_LIMITS.sideLabel, { required: "Side label is required" }).default("Bride"),
  sideLabel2: safeText(FIELD_LIMITS.sideLabel, { required: "Side label is required" }).default("Groom"),
  // TS-17 (FR-12.2): the cutoff after which a guest's own RSVP link becomes read-only. Optional --
  // omitting it (or explicitly clearing it) means no cutoff at all, matching the FR's "or none"
  // language exactly.
  rsvpCutoffDate: calendarDateField.optional().nullable(),
});

// TS-19 (FR-14.4): "start this new wedding from an existing template" is only ever offered at
// creation time -- not a later update -- so these fields live only on createWeddingSchema, never
// on updateWeddingSchema below. templateId alone picks nothing; the planner must also check at
// least one of applyTemplateTables/applyTemplateRules (mirroring FR-14.4's own "table layout
// and/or rule-shape" phrasing), or the request is rejected rather than silently applying nothing.
export const createWeddingSchema = weddingBaseSchema
  .extend({
    templateId: z.string().min(1).optional(),
    applyTemplateTables: z.boolean().default(false),
    applyTemplateRules: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    checkSideLabels(data, ctx);
    if (data.templateId && !data.applyTemplateTables && !data.applyTemplateRules) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pick at least one part of the template to use: its table layout, its side-mixing setting, or both.",
        path: ["templateId"],
      });
    }
  });
export type CreateWeddingInput = z.infer<typeof createWeddingSchema>;

// TS-190: one side name can be saved on its own -- the route also checks it against the other,
// stored one (see sideLabelsClash).
// TS-214: expectedRevision is the settingsRevision the change is based on -- a save made from an
// older copy is refused (409, with the latest settings) instead of putting back another tab's change.
// Required (Copilot review): a save without it used to skip the check altogether.
export const updateWeddingSchema = weddingBaseSchema
  .partial()
  .extend({ expectedRevision: expectedRevisionField.unwrap() })
  .superRefine(checkSideLabels);
export type UpdateWeddingInput = z.infer<typeof updateWeddingSchema>;

export interface WeddingDTO {
  id: string;
  ownerId: string;
  name: string;
  eventDate: string | null;
  venueName: string | null;
  // FR-1.3
  note: string | null;
  guestCount: number;
  // TS-177: everyone the guests bring (the sum of headcounts) -- guestCount counts invitations.
  peopleCount: number;
  // TS-214: the people coming (headcounts of guests marked Attending), as the Tables tab counts them.
  attendingCount: number;
  // TS-214: send back as expectedRevision when saving a setting.
  settingsRevision: number;
  // FR-10.2: per-wedding opt-out for the email side of notifications (the in-app notification
  // itself always fires regardless).
  emailNotificationsEnabled: boolean;
  // FR-3.4
  sideMixing: SideMixing;
  // FR-1.3a
  sideLabel1: string;
  sideLabel2: string;
  // TS-17 (FR-12.2): null means no RSVP cutoff at all.
  rsvpCutoffDate: string | null;
  createdAt: string;
  updatedAt: string;
}

// FR-11.2 (TS-16): the planner-portfolio dashboard's row shape -- everything WeddingDTO has, plus
// the Current Plan Version's status and its unassigned/Needs Reassignment counts, so a planner can
// tell whether a wedding needs attention without opening it. Only the dashboard list endpoint
// (`GET /api/v1/weddings`) returns this; every other wedding read still returns plain WeddingDTO.
export interface WeddingSummaryDTO extends WeddingDTO {
  // null: no plan version has been generated for this wedding yet ("No plan yet").
  planStatus: "DRAFT" | "IN_REVIEW" | "APPROVED" | null;
  unassignedCount: number;
  needsReassignmentCount: number;
}
