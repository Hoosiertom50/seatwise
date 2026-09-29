// TS-94: when an active session's token gets quietly re-issued. Competitors' most-cited session
// complaint is being logged out mid-work; before TS-94 Seatwise's token simply died 30 days after
// sign-in no matter how actively it was being used -- including, potentially, on the wedding day.
//
// Kept a pure function of (token claims, now) with no Next.js or cookie dependencies, so the policy
// can be unit-tested directly (session-renewal.test.ts) and reasoned about in one place.

/** Re-issue once a token is at least this old, so a session in use is never more than a day from
 * a fresh 30-day lifetime -- without re-signing on every single request. */
export const RENEW_AFTER_SECONDS = 60 * 60 * 24;

/** Stop renewing this long after the user last actually signed in. Sliding renewal alone would
 * let a stolen token live forever as long as someone kept using it; this caps any one sign-in at
 * 90 days of renewals (plus the final token's own 30 days). */
export const RENEWAL_LIMIT_SECONDS = 60 * 60 * 24 * 90;

export function shouldRenew(claims: { issuedAt: number; authTime: number }, nowSeconds: number): boolean {
  if (nowSeconds - claims.issuedAt < RENEW_AFTER_SECONDS) return false;
  if (nowSeconds - claims.authTime >= RENEWAL_LIMIT_SECONDS) return false;
  return true;
}

/** Response header carrying a renewed token to a Bearer-token client (the mobile app), which has no
 * cookie jar for the renewal to land in. Web clients get a refreshed cookie instead. */
export const RENEWED_TOKEN_HEADER = "x-seatwise-renewed-token";
