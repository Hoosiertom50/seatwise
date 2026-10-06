import { z } from "zod";
// TS-180: free text refuses hidden control characters (see ../safe-text).
import { safeText } from "../safe-text";

// TS-17 (FR-12.1-FR-12.4): the guest-facing RSVP flow, reached via a unique unauthenticated
// token link rather than the normal (authenticated, planner-facing) guest schemas in guest.ts.

// Mirrors the invite-preview pattern in collaboration.ts (InvitePreviewDTO): reveal nothing until
// the token is confirmed genuinely valid, and separately flag CLOSED (valid token, but the
// wedding's rsvpCutoffDate has passed -- FR-12.2's "becomes read-only") from NOT_FOUND (no such
// token at all, or it was never issued / no longer exists).
export const rsvpPreviewStatusEnum = z.enum(["OPEN", "CLOSED", "NOT_FOUND"]);
export type RsvpPreviewStatus = z.infer<typeof rsvpPreviewStatusEnum>;

// The public, token-lookup view (the guest's own RSVP page). When OPEN or CLOSED, pre-fills with
// whatever the guest (or their planner) already has on file -- FR-12.2's "shows their existing
// answers" -- so re-opening the link after responding shows what was submitted, and CLOSED still
// renders those answers read-only rather than an empty form.
export interface GuestRsvpPreviewDTO {
  status: RsvpPreviewStatus;
  weddingName?: string;
  firstName?: string;
  lastName?: string;
  headcount?: number;
  // TS-154: the most people this guest may RSVP for (the party size the planner set).
  maxHeadcount?: number;
  rsvpStatus?: "PENDING" | "CONFIRMED" | "DECLINED";
  plusOneNames?: string | null;
  // TS-107: the guest's own note (stored as Guest.rsvpNotes). Never the planner's private
  // Guest.notes, which this public flow must not read or write.
  notes?: string | null;
  requiresAccessibleTable?: boolean;
  // Echoed back so the page can show "responses closed on <date>" rather than just "closed".
  rsvpCutoffDate?: string | null;
}

// FR-12.1: what a guest can actually submit through their own link. Deliberately narrower than
// createGuestSchema/updateGuestSchema -- a guest answers for themselves (attending or not, party
// details), never touches planner-only fields like tier, side, isLocked, or dayOfAttendance.
// rsvpStatus excludes PENDING: submitting the form is itself the act of answering, so there's no
// "submit as still-undecided" case.
export const submitGuestRsvpSchema = z.object({
  rsvpStatus: z.enum(["CONFIRMED", "DECLINED"]),
  headcount: z.number().int().min(1).max(20).default(1),
  plusOneNames: safeText(500, { multiline: true }).optional().nullable(),
  notes: safeText(2000, { multiline: true }).optional().nullable(),
  requiresAccessibleTable: z.boolean().default(false),
});
export type SubmitGuestRsvpInput = z.infer<typeof submitGuestRsvpSchema>;

// FR-12.4: the planner-facing "get/send or regenerate this guest's link" action. `regenerate:
// true` always issues a fresh token (invalidating the old link); `false` (default) reuses an
// existing token or lazily creates one if this guest has never had one.
export const rsvpLinkActionSchema = z.object({
  regenerate: z.boolean().default(false),
});
export type RsvpLinkActionInput = z.infer<typeof rsvpLinkActionSchema>;

export interface RsvpLinkDTO {
  url: string;
  // TS-156: not emailed because the planner has sent a lot of RSVP emails in a short time.
  emailLimited?: boolean;
  // TS-177: with emailLimited -- it was the account's daily allowance, so more can go tomorrow.
  emailLimitedToday?: boolean;
  // TS-177 (Tom's decision): not emailed because the wedding's RSVP cutoff has passed -- the link
  // would only open a "closed" page. It's still made, so the planner can copy it if they choose.
  rsvpClosed?: boolean;
  // TS-164: not emailed because the planner hasn't confirmed their own email address yet.
  confirmEmailFirst?: boolean;
  // TS-171: not emailed again because this link already went to this address within the hour.
  recentlyEmailed?: boolean;
  // TS-171: not emailed because this address has already had its share of Seatwise email today.
  recipientLimited?: boolean;
  // TS-132: true only when the email really went out (or, in local dev/CI, was logged) -- lets the
  // UI say "link emailed to X" vs. "link copied".
  emailed: boolean;
  // TS-132: the guest has an email on file but sending failed or isn't set up -- the UI says so,
  // so the planner knows to send the link themselves.
  emailFailed: boolean;
}

// TS-143 / TS-177: what adding or editing a guest reports about the RSVP email it sent (or didn't)
// -- the same outcome as RsvpLinkDTO, without the link itself.
export type RsvpEmailOutcomeDTO = Required<Omit<RsvpLinkDTO, "url">>;
