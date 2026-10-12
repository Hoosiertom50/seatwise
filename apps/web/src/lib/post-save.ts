// TS-177: some edits are saved first and the seating plan re-checked afterwards (Needs
// Reassignment flags, completeness). If that second step fails, the edit is still saved -- so the
// route answers with success and this warning, rather than an error that says nothing was saved.
export const SAVED_BUT_NOT_RECHECKED =
  "Saved, but the seating plan couldn't be re-checked just now — refresh the page to see the latest.";

// TS-209: a step after the save that only reads something back (the saved record, the guest list)
// failed -- the change is saved, but the screen may not show it yet.
export const SAVED_BUT_NOT_REFRESHED = "Saved, but Seatwise couldn't load the latest just now — refresh the page to see it.";

/**
 * TS-209: runs one step that comes after a change has been committed. If it fails, the failure is
 * logged and `warning` (when given) is added to `warnings`, and `fallback` is returned -- a route
 * must never answer an error once something has been saved (the planner would think it wasn't,
 * and try again: a second guest, a second import).
 */
export async function afterSave<T>(
  what: string,
  step: () => Promise<T>,
  warnings: string[],
  warning: string | null,
  fallback: T
): Promise<T> {
  try {
    return await step();
  } catch (err) {
    console.error(`Saved, but ${what} failed:`, err);
    if (warning && !warnings.includes(warning)) warnings.push(warning);
    return fallback;
  }
}

// TS-209: what a guest route reports when emailing the RSVP link failed outright after the guest
// was saved (the link can still be sent with "RSVP link").
export const RSVP_EMAIL_FAILED = { url: "", emailed: false, emailFailed: true } as const;
