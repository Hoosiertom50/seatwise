import { NextRequest, NextResponse } from "next/server";
import { emailSafePersonName, forgotPasswordSchema } from "@seatwise/shared";
import {
  createPasswordResetToken,
  discardPasswordResetToken,
  findUserByEmail,
  hasUsablePasswordResetToken,
  peekRateLimit,
  sendEmail,
  PASSWORD_RESET_TTL_MINUTES,
  retireOlderResetTokens,
  emailDelivered,
} from "@seatwise/db";
import { readJson, zodErrorResponse } from "@/lib/api-response";
import {
  accountEmailCounters,
  accountSignInLocked,
  clientAddress,
  countOr429,
  PASSWORD_RESET_LIMITS,
  tooManyAttemptsMessage,
} from "@/lib/rate-limit";
import { appBaseUrl } from "@/lib/app-url";
import { resetOutcome } from "@/lib/password-reset-outcome";

// TS-142: "Forgot password?" -- emails a single-use, 1-hour reset link to an existing account.
// Tom's decision (2026-10-02): say plainly when there's no account for the email (sign-up already
// reveals whether an email is registered, so a vague answer protected nothing). Nothing is ever
// emailed to an address without an account. TS-145: and only say "sent" when it really was.
// Rate-limited per address and per email so it can't flood an inbox.
export async function POST(req: NextRequest) {
  const address = clientAddress(req);
  // TS-186: what this request has counted so far, so all of it is given back on any return that
  // sends no email.
  const counted: (() => Promise<void>)[] = [];
  const giveBackAll = async () => {
    for (const giveBack of counted.splice(0).reverse()) await giveBack();
  };
  const count = async (key: string, limits: { limit: number; windowSeconds: number }) => {
    const { limited, giveBack } = await countOr429(key, limits);
    if (limited) {
      await giveBackAll();
      return limited;
    }
    counted.push(giveBack);
    return null;
  };

  const limited =
    (await count(`pw-reset:addr:${address}`, PASSWORD_RESET_LIMITS.requestsPerAddress)) ??
    // TS-168: and per day, so one source can't spend the day's reset allowance on other people.
    (await count(`pw-reset:addr:day:${address}`, PASSWORD_RESET_LIMITS.requestsPerAddressDay));
  if (limited) return limited;
  // TS-186: these two count requests from the network address, sent or not, so they stay counted.
  counted.length = 0;

  // TS-179: refuses a body that isn't JSON (415) here too, not only in proxy.ts.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = forgotPasswordSchema.safeParse(json.body);
  if (!parsed.success) return zodErrorResponse(parsed.error);
  const email = parsed.data.email;
  const user = await findUserByEmail(email);
  // TS-186: nothing is emailed without an account, so nothing is counted against the email either.
  if (!user) return NextResponse.json(resetOutcome(false, null));

  // TS-171: while the last link sent still works (it lasts an hour), asking again sends nothing
  // new and cancels nothing -- the answer is the same as when it was sent. Otherwise anyone could
  // use up the person's resets for the day (each new link used to cancel the one before).
  if (await hasUsablePasswordResetToken(user.id)) return NextResponse.json(resetOutcome(true, "already-sent"));

  // TS-178: the link is built from the app's own address (see lib/app-url) -- worked out before
  // anything is counted.
  const appUrl = appBaseUrl();

  // TS-186: whether this network address has any account emails left today is checked first,
  // without counting anything -- so a source that has used up its own allowance can't go on using
  // up the per-email limits below (and with them the owner's resets for the day).
  // TS-203: the address's /48 too, for IPv6 (see accountEmailCounters).
  const networkCounters = accountEmailCounters(req);
  for (const { key, limit, windowSeconds } of networkCounters) {
    const ownAllowance = await peekRateLimit(key, limit, windowSeconds);
    if (!ownAllowance.allowed) {
      return NextResponse.json(
        { error: tooManyAttemptsMessage(windowSeconds, ownAllowance.retryAfterSeconds) },
        { status: 429, headers: { "Retry-After": String(ownAllowance.retryAfterSeconds) } }
      );
    }
  }

  const emailKey = email.toLowerCase();
  // TS-168: at most a handful of reset emails to one inbox a day, however they're asked for.
  // TS-178 / TS-186: while the account is locked by the sign-in limits, a higher daily limit
  // applies -- otherwise someone could lock the owner out with wrong passwords and then use up the
  // day's resets too, leaving them no way in until tomorrow. It's still a limit, so the inbox
  // can't be flooded either. The 15-minute limit, and "already sent" while a link still works,
  // hold either way.
  const locked = await accountSignInLocked(email);
  const perEmailDay = locked ? PASSWORD_RESET_LIMITS.requestsPerEmailDayWhileLocked : PASSWORD_RESET_LIMITS.requestsPerEmailDay;
  let overForEmail =
    (await count(`pw-reset:email:${emailKey}`, PASSWORD_RESET_LIMITS.requestsPerEmail)) ??
    (await count(`pw-reset:email:day:${emailKey}`, perEmailDay));
  // TS-171: counted with sign-ups and "Resend link" from the same address -- only when an email
  // is really about to go out.
  for (const { key, limit, windowSeconds } of networkCounters) {
    overForEmail ??= await count(key, { limit, windowSeconds });
  }
  if (overForEmail) return overForEmail;

  // TS-178: only an account that has confirmed its address is treated as the address's owner.
  // Anyone can sign up with someone else's address, so for an unconfirmed account a reset is an
  // everyday email (from its own share of the day, and within the address's daily share), and the
  // name typed at sign-up isn't put in front of whoever owns the inbox.
  const confirmed = user.emailVerifiedAt !== null;
  let token: string;
  try {
    token = await createPasswordResetToken(user.id);
  } catch (err) {
    await giveBackAll();
    throw err;
  }
  // TS-168: the account's name only goes into the email if it passes today's name rules.
  const safeName = confirmed ? emailSafePersonName(user.name) : null;
  const resetGreeting = safeName ? `Hi ${safeName}` : "Hi";
  const result = await sendEmail(
    user.email,
    "Reset your Seatwise password",
    `${resetGreeting},\n\nSomeone (hopefully you) asked to reset your Seatwise password. Choose a new one here:\n\n${appUrl}/reset-password/${token}\n\nThis link works once, for ${PASSWORD_RESET_TTL_MINUTES} minutes. If you didn't ask for this, you can ignore this email -- your password hasn't changed.`,
    process.env,
    // TS-163 / TS-186: a confirmed account's reset comes out of the resets' own daily budget, so
    // it still goes out when the everyday limit is reached; an unconfirmed account's is an
    // everyday email, from its own smaller share.
    // TS-203: a locked-out account may also use the resets kept for that.
    confirmed ? { essential: true, lockedOut: locked } : { unconfirmedReset: true }
  );
  // TS-153: older links are cancelled only once this one has gone out.
  if (emailDelivered(result)) await retireOlderResetTokens(user.id, token);
  else if (result === "uncertain") {
    // TS-203: the mail server went quiet after it may have taken the email -- it may well arrive,
    // so its link is kept working (and the counts stay). Older links are kept too, in case it didn't.
  } else {
    try {
      // TS-171: one that never went out is cancelled, so asking again isn't answered "already sent".
      await discardPasswordResetToken(token);
    } finally {
      // TS-178: and it doesn't use up the email's or the network address's allowance. TS-203:
      // given back even if cancelling the link failed.
      await giveBackAll();
    }
  }
  return NextResponse.json(resetOutcome(true, result));
}
