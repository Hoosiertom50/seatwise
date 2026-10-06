// TS-177: some edits are saved first and the seating plan re-checked afterwards (Needs
// Reassignment flags, completeness). If that second step fails, the edit is still saved -- so the
// route answers with success and this warning, rather than an error that says nothing was saved.
export const SAVED_BUT_NOT_RECHECKED =
  "Saved, but the seating plan couldn't be re-checked just now — refresh the page to see the latest.";
