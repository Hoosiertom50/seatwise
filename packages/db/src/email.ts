import nodemailer from "nodemailer";
import { Resend } from "resend";
import { hitRateLimitCount, undoRateLimitHit } from "./queries/rate-limit";

// TS-132: how Seatwise sends email, chosen from the environment:
//
// - SMTP (Tom's decision, 2026-10-01: a dedicated Gmail account, seatwise.notifications@gmail.com,
//   sending with a Gmail app password) -- when SMTP_USER and SMTP_PASSWORD are set. Host and port
//   default to Gmail's (smtp.gmail.com, 465/TLS).
// - Resend -- when RESEND_API_KEY is set instead (kept for later, once there's a domain).
// - "log" -- prints the email instead of sending it. The default outside production (local dev),
//   and what CI asks for explicitly with EMAIL_TRANSPORT=log, so no test ever sends real email.
// - none -- production with nothing configured. Nothing is sent, and callers are told so, so the
//   planner sees the link to share by hand instead of a false "sent".
//
// Sending never throws: a failed email must never block the action that triggered it.

// TS-171: "recipient-limited" -- this address has already had its share of Seatwise email today.
export type EmailResult = "sent" | "logged" | "not-configured" | "failed" | "limited" | "recipient-limited";

type EmailEnv = Record<string, string | undefined>;

export type EmailTransportConfig =
  | { kind: "smtp"; host: string; port: number; secure: boolean; user: string; pass: string; from: string }
  | { kind: "resend"; apiKey: string; from: string }
  | { kind: "log" }
  | { kind: "none" };

export function resolveEmailTransport(env: EmailEnv = process.env): EmailTransportConfig {
  // TS-172: an explicit "log" always wins -- even if Gmail or Resend credentials are also present
  // (say, in a developer's .env while the test suite runs), nothing is really sent.
  if (env.EMAIL_TRANSPORT === "log") return { kind: "log" };
  if (env.SMTP_USER && env.SMTP_PASSWORD) {
    const port = Number(env.SMTP_PORT || 465);
    return {
      kind: "smtp",
      host: env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465,
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
      // Gmail only sends as the account that signed in, so that's the default sender.
      from: env.EMAIL_FROM || `Seatwise <${env.SMTP_USER}>`,
    };
  }
  if (env.RESEND_API_KEY) {
    return {
      kind: "resend",
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM || env.RESEND_FROM_EMAIL || "Seatwise <notifications@seatwise.app>",
    };
  }
  if (env.EMAIL_TRANSPORT === "log" || env.NODE_ENV !== "production") return { kind: "log" };
  return { kind: "none" };
}

/** Whether the person was (or, in local dev and CI, would have been) emailed. */
export function emailDelivered(result: EmailResult): boolean {
  return result === "sent" || result === "logged";
}

type Sender = (config: EmailTransportConfig, message: { to: string; subject: string; text: string }) => Promise<void>;

let smtpTransport: ReturnType<typeof nodemailer.createTransport> | undefined;
let resendClient: Resend | undefined;

const realSender: Sender = async (config, message) => {
  if (config.kind === "smtp") {
    smtpTransport ??= nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      // A slow mail server must not hold up the planner's request for long.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    await smtpTransport.sendMail({ from: config.from, ...message });
  } else if (config.kind === "resend") {
    resendClient ??= new Resend(config.apiKey);
    const { error } = await resendClient.emails.send({ from: config.from, ...message });
    if (error) throw new Error(error.message);
  }
};

let sender: Sender = realSender;

// TS-163: a ceiling on how many emails Seatwise sends in a day, whoever triggers them. Everything
// goes out through one Gmail account (about 500 recipients a day); hitting Gmail's own limit gets
// the account throttled or suspended, which would stop password resets too. Per-person limits
// (TS-156) can be got round with many accounts; this can't. Password-reset emails ("essential")
// get extra headroom above the everyday ceiling, so they still go out on a busy day. Only real
// sends count -- the "log" transport used locally and in CI never touches this.
//
// TS-171: the headroom is for password resets only. Email-confirmation links used to share it,
// and anyone can sign up with someone else's address -- so a few sources could use it all up and
// stop everyone's password resets. Confirmations now come out of the everyday allowance.
const DAILY_WINDOW_SECONDS = 86_400;
const DAILY_KEY = "email:global:day";
const ESSENTIAL_HEADROOM = 80;

// TS-178: an email-address confirmation (anyone can sign up with any address) may only use this
// share of the everyday allowance, so a burst of sign-ups can't leave nothing for invites and RSVP
// emails. Past it the account is still made; "Resend link" works again tomorrow.
export const CONFIRMATION_SHARE_OF_EVERYDAY = 0.25;

export function dailyEmailLimits(env: EmailEnv = process.env): { everyday: number; essential: number; confirmations: number } {
  const configured = Number(env.EMAIL_DAILY_LIMIT);
  const everyday = Number.isInteger(configured) && configured > 0 ? configured : 400;
  return {
    everyday,
    essential: everyday + ESSENTIAL_HEADROOM,
    confirmations: Math.max(1, Math.floor(everyday * CONFIRMATION_SHARE_OF_EVERYDAY)),
  };
}

type DailyCounter = { hit: () => Promise<number>; undo: () => Promise<void> };
const realDailyCounter: DailyCounter = {
  hit: () => hitRateLimitCount(DAILY_KEY, DAILY_WINDOW_SECONDS),
  undo: () => undoRateLimitHit(DAILY_KEY, DAILY_WINDOW_SECONDS),
};
let dailyCounter: DailyCounter = realDailyCounter;

// TS-178: the confirmations' own share, counted the same way (real sends only).
const CONFIRMATIONS_KEY = "email:global:confirmations:day";
const realConfirmationCounter: DailyCounter = {
  hit: () => hitRateLimitCount(CONFIRMATIONS_KEY, DAILY_WINDOW_SECONDS),
  undo: () => undoRateLimitHit(CONFIRMATIONS_KEY, DAILY_WINDOW_SECONDS),
};
let confirmationCounter: DailyCounter = realConfirmationCounter;

/** Tests only: replace the counter for the confirmations' share (pass nothing to restore it). */
export function setConfirmationEmailCounterForTests(fake?: DailyCounter): void {
  confirmationCounter = fake ?? realConfirmationCounter;
}

// TS-171: at most a few emails a day to any one address, however they're asked for and by however
// many accounts -- so nobody can use Seatwise to fill a stranger's inbox. Password resets have
// their own per-address limits (see the forgot-password route), and notifications only go to
// confirmed members of a wedding who can turn them off, so neither counts here. Unlike the daily
// ceiling this also counts with the "log" transport, so it behaves the same locally and in CI.
export const EMAILS_PER_RECIPIENT_PER_DAY = 5;

/**
 * TS-178: the mailbox an address really reaches, for the per-address count only (the email still
 * goes to the address as given). Upper/lower case, a "+tag" and -- for Gmail -- dots all reach the
 * same inbox, so they used to count as different addresses.
 */
export function recipientCountAddress(to: string): string {
  const lowered = to.trim().toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at <= 0) return lowered;
  let local = lowered.slice(0, at);
  let domain = lowered.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}
const recipientKey = (to: string) => `email:to:day:${recipientCountAddress(to)}`;

/** TS-178: an address as the logs show it -- "v***@gmail.com" -- so logs don't collect people's addresses. */
export function maskEmailAddress(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${trimmed[0]}***${trimmed.slice(at)}`;
}

type RecipientCounter = { hit: (to: string) => Promise<number>; undo: (to: string) => Promise<void> };
const realRecipientCounter: RecipientCounter = {
  hit: (to) => hitRateLimitCount(recipientKey(to), DAILY_WINDOW_SECONDS),
  undo: (to) => undoRateLimitHit(recipientKey(to), DAILY_WINDOW_SECONDS),
};
let recipientCounter: RecipientCounter = realRecipientCounter;

/** Tests only: replace the per-recipient email counter (pass nothing to restore it). */
export function setRecipientEmailCounterForTests(fake?: RecipientCounter): void {
  recipientCounter = fake ?? realRecipientCounter;
}

// TS-171: every email one signed-in account can make Seatwise send in a day, of every kind
// (invites, RSVP emails, notifications its actions set off), counted together. Without it, the
// separate per-kind limits added up to more than the whole day's allowance, so one account could
// stop email for everyone.
export const ACCOUNT_EMAILS_PER_DAY = { limit: 100, windowSeconds: DAILY_WINDOW_SECONDS } as const;
export const accountDailyEmailKey = (userId: string) => `email:account:day:${userId}`;

/** Tests only: replace the daily email counter (pass nothing to restore it). */
export function setDailyEmailCounterForTests(fake?: DailyCounter): void {
  dailyCounter = fake ?? realDailyCounter;
}

/** Tests only: replace the real SMTP/Resend sender (pass nothing to restore it). */
export function setEmailSenderForTests(fake?: Sender): void {
  sender = fake ?? realSender;
}

export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  env: EmailEnv = process.env,
  {
    essential = false,
    toWeddingMember = false,
    confirmation = false,
  }: {
    /** A password reset: may use the reserved headroom, and has its own per-address limits. */
    essential?: boolean;
    /** TS-171: a notification to a confirmed member of the wedding -- not a stranger. */
    toWeddingMember?: boolean;
    /** TS-178: an email-address confirmation -- limited to its own share of the everyday allowance. */
    confirmation?: boolean;
  } = {}
): Promise<EmailResult> {
  // TS-178: addresses are masked in every log line here.
  const shown = maskEmailAddress(to);
  const config = resolveEmailTransport(env);
  if (config.kind === "none") {
    console.warn(`[email] not sent to ${shown}: no email service is configured (set SMTP_USER and SMTP_PASSWORD).`);
    return "not-configured";
  }
  const recipientCapped = !essential && !toWeddingMember;
  const recipient = recipientCountAddress(to);
  // TS-178: everything this attempt has counted so far, so all of it is given back (once) when
  // nothing goes out -- refused, or failed to send.
  const counted: (() => Promise<void>)[] = [];
  const giveBack = async () => {
    for (const undo of counted.splice(0).reverse()) {
      await undo().catch((err) => console.error(`[email] couldn't give back a count: ${errorText(err)}`));
    }
  };

  // TS-178: sending never throws -- not even when the counters (in the database) can't be reached.
  // The email just isn't sent, and the caller hears "failed".
  try {
    if (recipientCapped) {
      const toThisAddress = await recipientCounter.hit(recipient);
      counted.push(() => recipientCounter.undo(recipient));
      if (toThisAddress > EMAILS_PER_RECIPIENT_PER_DAY) {
        // Taken back, so refused attempts don't pile up on the count.
        await giveBack();
        console.warn(`[email] not sent to ${shown}: this address has had ${EMAILS_PER_RECIPIENT_PER_DAY} emails from Seatwise today.`);
        return "recipient-limited";
      }
    }
    if (config.kind === "log") {
      // TS-149: in a production build (CI's e2e server, or the live site if someone set
      // EMAIL_TRANSPORT=log) the links' secret parts are hidden, so the logs never hold a working
      // sign-in, invite, RSVP or vendor link. Local development keeps the full text, so a developer
      // can still click a link from their terminal. TS-178: the same goes for the address.
      const production = env.NODE_ENV === "production";
      const body = production ? redactLinkTokens(text) : text;
      console.log(`[email-log] to=${production ? shown : to} subject="${subject}" body="${body}"`);
      return "logged";
    }
    const limits = dailyEmailLimits(env);
    if (confirmation) {
      const confirmationsToday = await confirmationCounter.hit();
      counted.push(() => confirmationCounter.undo());
      if (confirmationsToday > limits.confirmations) {
        await giveBack();
        console.warn(`[email] not sent to ${shown}: today's share of ${limits.confirmations} email confirmations has been used.`);
        return "limited";
      }
    }
    const sentToday = await dailyCounter.hit();
    counted.push(() => dailyCounter.undo());
    if (sentToday > (essential ? limits.essential : limits.everyday)) {
      // Taken back, so refused everyday emails don't eat into the password-reset headroom.
      await giveBack();
      console.warn(`[email] not sent to ${shown}: today's limit of ${limits.everyday} emails has been reached.`);
      return "limited";
    }
  } catch (err) {
    await giveBack();
    console.error(`[email] not sent to ${shown}: today's email counts couldn't be checked: ${errorText(err)}`);
    return "failed";
  }
  try {
    await sender(config, { to, subject, text });
    return "sent";
  } catch (err) {
    // Never log the password or the message body -- just who and why.
    console.error(`[email] failed to send to ${shown} via ${config.kind}: ${errorText(err)}`);
    // TS-178: nothing went out, so it doesn't use up the day's allowance or the address's share.
    await giveBack();
    return "failed";
  }
}

// TS-178: a mail server's error often repeats the recipient ("550 <someone@example.com> rejected"),
// so any address in it is masked too.
const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/[^\s<>()"',;:@]+@[^\s<>()"',;:@]+/g, (address) => maskEmailAddress(address));

/** TS-149: hides the secret part of every Seatwise link (reset, invite, RSVP, vendor) in a text. */
export function redactLinkTokens(text: string): string {
  return text.replace(/(\/(?:reset-password|verify-email|invites|rsvp|vendor)\/)[0-9a-f]{16,}/gi, "$1[hidden]");
}
