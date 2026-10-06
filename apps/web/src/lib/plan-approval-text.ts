// TS-179: shown when Generate or Restore by someone who can't undo an approval was saved as a
// comparison draft, because the current plan is approved. Shared by the routes and the Plan tab.
export const SAVED_AS_DRAFT_BECAUSE_APPROVED =
  "The plan is approved, so this was saved as a comparison draft — only the owner or a Couple member can replace an approved plan.";

// TS-189: shown when a Generate asked for a comparison draft but the wedding had no current plan --
// the new version was made current instead (a draft beside nothing can't be approved or exported).
export const MADE_CURRENT_BECAUSE_NO_CURRENT_PLAN =
  "There was no current plan yet, so this version was made the current plan rather than a comparison draft.";
