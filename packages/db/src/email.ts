import nodemailer from "nodemailer";
import { Resend } from "resend";

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

export type EmailResult = "sent" | "logged" | "not-configured" | "failed";

type EmailEnv = Record<string, string | undefined>;

export type EmailTransportConfig =
  | { kind: "smtp"; host: string; port: number; secure: boolean; user: string; pass: string; from: string }
  | { kind: "resend"; apiKey: string; from: string }
  | { kind: "log" }
  | { kind: "none" };

export function resolveEmailTransport(env: EmailEnv = process.env): EmailTransportConfig {
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

/** Tests only: replace the real SMTP/Resend sender (pass nothing to restore it). */
export function setEmailSenderForTests(fake?: Sender): void {
  sender = fake ?? realSender;
}

export async function sendEmail(to: string, subject: string, text: string, env: EmailEnv = process.env): Promise<EmailResult> {
  const config = resolveEmailTransport(env);
  if (config.kind === "log") {
    // TS-149: in a production build (CI's e2e server, or the live site if someone set
    // EMAIL_TRANSPORT=log) the links' secret parts are hidden, so the logs never hold a working
    // sign-in, invite, RSVP or vendor link. Local development keeps the full text, so a developer
    // can still click a link from their terminal.
    const body = env.NODE_ENV === "production" ? redactLinkTokens(text) : text;
    console.log(`[email-log] to=${to} subject="${subject}" body="${body}"`);
    return "logged";
  }
  if (config.kind === "none") {
    console.warn(`[email] not sent to ${to}: no email service is configured (set SMTP_USER and SMTP_PASSWORD).`);
    return "not-configured";
  }
  try {
    await sender(config, { to, subject, text });
    return "sent";
  } catch (err) {
    // Never log the password or the message body -- just who and why.
    console.error(`[email] failed to send to ${to} via ${config.kind}: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

/** TS-149: hides the secret part of every Seatwise link (reset, invite, RSVP, vendor) in a text. */
export function redactLinkTokens(text: string): string {
  return text.replace(/(\/(?:reset-password|invites|rsvp|vendor)\/)[0-9a-f]{16,}/gi, "$1[hidden]");
}
