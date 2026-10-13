import { formatDate } from "./display-format";

// TS-263 (Tom's decision, 10-13): a wedding date before today is usually a typo (most often the
// wrong year), but there are real uses too -- recording a wedding that already happened, say. So
// it's allowed, but the planner is asked first, the same way as the RSVP cutoff (TS-214). This is
// only a question in the browser; the server keeps accepting past dates.

/**
 * The question to ask before saving this wedding date, or null to save it straight away. Dates are
 * "YYYY-MM-DD" (they compare as text); `today` is the planner's own date (localTodayIso). An empty
 * date, today or a later date never asks.
 */
export function pastWeddingDateQuestion(date: string, today: string): string | null {
  if (!date || date >= today) return null;
  return `This date (${formatDate(date)}) has already passed — is that right?`;
}

/**
 * TS-263: the question for Collaborators → Date and venue. Only a changed date asks -- saving just
 * a new venue for a wedding whose (past) date is already saved goes straight through.
 */
export function changedWeddingDateQuestion(typed: string, saved: string | null, today: string): string | null {
  if (typed === (saved ?? "")) return null;
  return pastWeddingDateQuestion(typed, today);
}
