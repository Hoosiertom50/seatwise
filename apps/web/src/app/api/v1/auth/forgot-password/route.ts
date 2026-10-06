import { NextRequest, NextResponse } from "next/server";
import { emailSafePersonName, forgotPasswordSchema } from "@seatwise/shared";
import {
  createPasswordResetToken,
  discardPasswordResetToken,
  findUserByEmail,
  hasUsablePasswordResetToken,
  sendEmail,
  PASSWORD_RESET_TTL_MINUTES,
  retireOlderResetTokens,
  emailDelivered,
  undoRateLimitHit,
} from "@seatwise/db";
import { zodErrorResponse } from "@/lib/api-response";
import {
  accountEmailAddressKey,
  ACCOUNT_EMAIL_LIMITS,
  accountSignInLocked,
  clientAddress,
  rateLimitOr429,
  PASSWORD_RESET_LIMITS,
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
  const limited =
    (await rateLimitOr429(`pw-reset:addr:${address}`, PASSWORD_RESET_LIMITS.requestsPerAddress)) ??
    // TS-168: and per day, so one source can't spend the day's reset allowance on other people.
    (await rateLimitOr429(`pw-reset:addr:day:${address}`, PASSWORD_RESET_LIMITS.requestsPerAddressDay));
  if (limited) return limited;

  const parsed = forgotPasswordSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return zodErrorResponse(parsed.error);
  const email = parsed.data.email;
  const user = await findUserByEmail(email);

  // TS-171: while the last link sent still works (it lasts an hour), asking again sends nothing
  // new and cancels nothing -- the answer is the same as when it was sent. Otherwise anyone could
  // use up the person's resets for the day (each new link used to cancel the one before).
  if (user && (await hasUsablePasswordResetToken(user.id))) return NextResponse.json(resetOutcome(true, "already-sent"));

  // TS-178: the link is built from the app's own address (see lib/app-url) -- worked out before
  // anything is counted.
  const appUrl = appBaseUrl();

  // TS-178: what this request has counted against the per-email and per-address limits, so it can
  // all be given back if no email goes out after all.
  const counted: { key: string; windowSeconds: number }[] = [];
  const emailKey = email.toLowerCase();
  const perEmail = await rateLimitOr429(`pw-reset:email:${emailKey}`, PASSWORD_RESET_LIMITS.requestsPerEmail);
  if (perEmail) return perEmail;
  counted.push({ key: `pw-reset:email:${emailKey}`, windowSeconds: PASSWORD_RESET_LIMITS.requestsPerEmail.windowSeconds });
  // TS-168: at most a handful of reset emails to one inbox a day, however they're asked for.
  // TS-178: except while the account is locked by the sign-in limits -- otherwise someone could
  // lock the owner out with wrong passwords and then use up the day's resets too, leaving them no
  // way in until tomorrow. The 15-minute limit above, and "already sent" while a link still works,
  // still hold.
  if (!(user && (await accountSignInLocked(email)))) {
    const perEmailDay = await rateLimitOr429(`pw-reset:email:day:${emailKey}`, PASSWORD_RESET_LIMITS.requestsPerEmailDay);
    if (perEmailDay) return perEmailDay;
    counted.push({ key: `pw-reset:email:day:${emailKey}`, windowSeconds: PASSWORD_RESET_LIMITS.requestsPerEmailDay.windowSeconds });
  }

  if (!user) return NextResponse.json(resetOutcome(false, null));

  // TS-171: counted with sign-ups and "Resend link" from the same address -- only when an email
  // is really about to go out.
  const perAddressEmails = await rateLimitOr429(accountEmailAddressKey(address), ACCOUNT_EMAIL_LIMITS.perAddressDay);
  if (perAddressEmails) return perAddressEmails;
  counted.push({ key: accountEmailAddressKey(address), windowSeconds: ACCOUNT_EMAIL_LIMITS.perAddressDay.windowSeconds });

  // TS-178: only an account that has confirmed its address is treated as the address's owner.
  // Anyone can sign up with someone else's address, so for an unconfirmed account a reset is an
  // everyday email (no reserved headroom, and within the address's daily share), and the name
  // typed at sign-up isn't put in front of whoever owns the inbox.
  const confirmed = user.emailVerifiedAt !== null;
  const token = await createPasswordResetToken(user.id);
  // TS-168: the account's name only goes into the email if it passes today's name rules.
  const safeName = confirmed ? emailSafePersonName(user.name) : null;
  const resetGreeting = safeName ? `Hi ${safeName}` : "Hi";
  const result = await sendEmail(
    user.email,
    "Reset your Seatwise password",
    `${resetGreeting},\n\nSomeone (hopefully you) asked to reset your Seatwise password. Choose a new one here:\n\n${appUrl}/reset-password/${token}\n\nThis link works once, for ${PASSWORD_RESET_TTL_MINUTES} minutes. If you didn't ask for this, you can ignore this email -- your password hasn't changed.`,
    process.env,
    // TS-163: password resets still go out when the day's everyday email limit is reached.
    { essential: confirmed }
  );
  // TS-153: older links are cancelled only once this one has gone out.
  if (emailDelivered(result)) await retireOlderResetTokens(user.id, token);
  else {
    // TS-171: one that never went out is cancelled, so asking again isn't answered "already sent".
    await discardPasswordResetToken(token);
    // TS-178: and it doesn't use up the email's or the network address's allowance.
    await Promise.all(counted.map(({ key, windowSeconds }) => undoRateLimitHit(key, windowSeconds)));
  }
  return NextResponse.json(resetOutcome(true, result));
}