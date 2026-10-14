import { api } from "./api-client";

// TS-264: Log out is on every signed-in page now (the shared header), not just the dashboard.

/**
 * What the header passes to a page's `onLeave` for Log out, in place of an address -- so the
 * wedding page's unsaved-changes guard can ask (or wait for saves) first, the same as for "Back to
 * dashboard", and then log out instead of following a link.
 */
export const LOG_OUT = "__log_out__";

// TS-175: a failed log out says so (it used to fail silently).
export const LOG_OUT_FAILED_MESSAGE = "Couldn't log out — check your connection and try again.";

/**
 * TS-204 (Tom's decision): signs out this device only -- "Log out on all devices" is on the Account
 * page. True when it worked; the caller then replaces the page with the sign-in page (TS-175: so
 * Back doesn't bounce between this page and the sign-in page).
 */
/**
 * Review 14: after a log out, opens the sign-in page as a new page load (replacing this page in
 * history, as before). It used to be an in-app route change, and when the wedding page's own Back
 * (taking its extra history entry off just after a save) landed in the same moment, Next.js went
 * back to the wedding instead -- signed out, but with the wedding (guest names, notes) still on
 * screen, e.g. on a shared Day-of tablet. A page load also leaves nothing of the old page in memory.
 * If the page is somehow still here a moment later, it goes again.
 */
export function goToSignIn(): void {
  window.location.replace("/login");
  window.setTimeout(() => window.location.replace("/login"), 2000);
}

export async function logOutThisDevice(): Promise<boolean> {
  try {
    await api.post("/api/v1/auth/logout");
    return true;
  } catch {
    return false;
  }
}
