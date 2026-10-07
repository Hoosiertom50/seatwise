import { emailDelivered, emailMayHaveGone, hitRateLimit, undoRateLimitHit } from "@seatwise/db";
import { accountEmailCounters } from "./rate-limit";
import { sendVerificationEmail } from "./email-verification";

type Hit = { allowed: boolean; windowStart: Date };

// Tests only: stand-ins for the counters and the email (see setSignupEmailForTests).
let hitCounter: (key: string, limit: number, windowSeconds: number) => Promise<Hit> = hitRateLimit;
let undoCounter: (key: string, windowSeconds: number, windowStart: Date) => Promise<void> = undoRateLimitHit;
let sendConfirmation: typeof sendVerificationEmail = sendVerificationEmail;

/** Tests only: replace the counters and the email sender (pass nothing to restore them). */
export function setSignupEmailForTests(fakes?: {
  hit: typeof hitCounter;
  undo: typeof undoCounter;
  send: typeof sendConfirmation;
}): void {
  hitCounter = fakes?.hit ?? hitRateLimit;
  undoCounter = fakes?.undo ?? undoRateLimitHit;
  sendConfirmation = fakes?.send ?? sendVerificationEmail;
}

/**
 * A new account's confirmation email, sent by the sign-up route; whether it went out.
 * TS-171: it counts with resends and resets from this address. Past the address's daily allowance
 * the account is still made (a whole office may sign up from one network) -- just without the
 * email; the banner offers "Resend link" for later.
 * TS-194: one count per network address (10 a day) for every email an outsider can trigger -- it
 * replaces the separate count of sign-up confirmations (see ACCOUNT_EMAIL_LIMITS).
 * TS-203: rolling over 24 hours, and for IPv6 the /48 as well (see accountEmailCounters).
 * TS-220: never throws. The account is already made when this runs, so anything going wrong here
 * (the database busy) is logged and answered false -- it used to turn the made account into a 500.
 */
export async function sendFirstConfirmationEmail(req: { headers: Headers }, user: { id: string; email: string }): Promise<boolean> {
  const emailCounters = accountEmailCounters(req);
  const hits: (Hit | null)[] = emailCounters.map(() => null);
  let givenBack = false;
  const giveBack = async () => {
    if (givenBack) return;
    givenBack = true;
    await Promise.all(
      emailCounters.map(async ({ key, windowSeconds }, i) => {
        const hit = hits[i];
        if (hit) await undoCounter(key, windowSeconds, hit.windowStart);
      })
    );
  };
  try {
    // TS-227: every count settles before anything is decided, so a count that lands after another
    // one failed is still known -- and given back below -- rather than left behind.
    const settled = await Promise.allSettled(
      emailCounters.map(async ({ key, limit, windowSeconds }, i) => {
        hits[i] = await hitCounter(key, limit, windowSeconds);
      })
    );
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    const mayEmail = hits.every((h) => h?.allowed);
    // TS-178: the email also has to fit in the confirmations' own share of the day's email (see
    // sendEmail's `confirmation`); past it, the same happens -- account made, no email.
    const result = mayEmail ? await sendConfirmation(user) : null;
    // TS-178 / TS-186: nothing went out (refused, or not sent), so it doesn't use up either
    // allowance. TS-203: unless it may have gone out after all ("uncertain").
    if (result === null || !emailMayHaveGone(result)) await giveBack();
    return result !== null && emailDelivered(result);
  } catch (err) {
    console.error(`[signup] account made, but its confirmation email wasn't sent: ${err instanceof Error ? err.message : String(err)}`);
    await giveBack().catch(() => {});
    return false;
  }
}
