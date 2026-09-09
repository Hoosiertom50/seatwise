import { z } from "zod";

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
  rsvpStatus?: "PENDING" | "CONFIRMED" | "DECLINED";
  plusOneNames?: string | null;
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
  plusOneNames: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
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
  // true when the guest has an email on file and sendEmailNotification was attempted for it --
  // mirrors the invite-send pattern, and lets the UI say "link copied" vs. "link emailed to X".
  emailed: boolean;
}
