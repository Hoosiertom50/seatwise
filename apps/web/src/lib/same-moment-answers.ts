import { errorResponse } from "./api-response";

// TS-242: what a vendor change or an invite accept says when it lost a race with another change --
// the database broke a deadlock (40P01) or asked for a retry (40001). Nothing was saved. Before, a
// vendor edit said the plan had changed, and an accept answered a server error.
export const VENDOR_SAME_MOMENT_MESSAGE =
  "Someone else changed this wedding's vendors at the same moment — nothing was saved. Please try again.";
export const INVITE_ACCEPT_SAME_MOMENT_MESSAGE =
  "This invite was being changed at the same moment — nothing was saved. Please try again.";

function isSameMoment(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "40P01" || code === "40001";
}

/** TS-242: a 409 with the vendor wording for a lost race; null for anything else. */
export function vendorSameMomentResponse(err: unknown) {
  return isSameMoment(err) ? errorResponse(VENDOR_SAME_MOMENT_MESSAGE, 409) : null;
}

/** TS-242: a 409 "try again" for an accept that lost a race; null for anything else. */
export function inviteAcceptSameMomentResponse(err: unknown) {
  return isSameMoment(err) ? errorResponse(INVITE_ACCEPT_SAME_MOMENT_MESSAGE, 409) : null;
}
