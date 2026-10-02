// TS-132: unit tests for how Seatwise picks an email service and reports what happened
// (packages/db/src/email.ts). Run with `pnpm --filter @seatwise/web test`. The real SMTP/Resend
// sender is swapped for a fake, so nothing here ever sends an email.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const { resolveEmailTransport, sendEmail, emailDelivered, setEmailSenderForTests, redactLinkTokens } = await import("@seatwise/db");

afterEach(() => setEmailSenderForTests());

test("Gmail is used when SMTP_USER and SMTP_PASSWORD are set, with Gmail's host, TLS port and the account as sender", () => {
  const config = resolveEmailTransport({ NODE_ENV: "production", SMTP_USER: "seatwise.notifications@gmail.com", SMTP_PASSWORD: "app-pass" });
  assert.deepEqual(config, {
    kind: "smtp",
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    user: "seatwise.notifications@gmail.com",
    pass: "app-pass",
    from: "Seatwise <seatwise.notifications@gmail.com>",
  });
});

test("SMTP settings win over Resend, and port 587 uses STARTTLS rather than implicit TLS", () => {
  const config = resolveEmailTransport({ SMTP_USER: "u@example.invalid", SMTP_PASSWORD: "p", SMTP_PORT: "587", RESEND_API_KEY: "re_x" });
  assert.equal(config.kind, "smtp");
  assert.equal(config.kind === "smtp" && config.secure, false);
});

test("Resend is used when only RESEND_API_KEY is set", () => {
  assert.equal(resolveEmailTransport({ NODE_ENV: "production", RESEND_API_KEY: "re_x" }).kind, "resend");
});

test("with nothing configured: local dev logs, production sends nothing, and EMAIL_TRANSPORT=log logs even in production", () => {
  assert.equal(resolveEmailTransport({ NODE_ENV: "development" }).kind, "log");
  assert.equal(resolveEmailTransport({ NODE_ENV: "production" }).kind, "none");
  assert.equal(resolveEmailTransport({ NODE_ENV: "production", EMAIL_TRANSPORT: "log" }).kind, "log");
});

test("a successful send reports sent, with the right sender, recipient and text", async () => {
  const seen: unknown[] = [];
  setEmailSenderForTests(async (config, message) => {
    seen.push({ kind: config.kind, from: config.kind === "smtp" ? config.from : null, ...message });
  });
  const result = await sendEmail("guest@example.invalid", "RSVP", "Please RSVP", {
    NODE_ENV: "production",
    SMTP_USER: "seatwise.notifications@gmail.com",
    SMTP_PASSWORD: "app-pass",
  });
  assert.equal(result, "sent");
  assert.deepEqual(seen, [
    { kind: "smtp", from: "Seatwise <seatwise.notifications@gmail.com>", to: "guest@example.invalid", subject: "RSVP", text: "Please RSVP" },
  ]);
});

test("a failed send reports failed, never throws, and never logs the password", async () => {
  setEmailSenderForTests(async () => {
    throw new Error("Invalid login: 535 Username and Password not accepted");
  });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    const result = await sendEmail("guest@example.invalid", "RSVP", "Please RSVP", {
      NODE_ENV: "production",
      SMTP_USER: "seatwise.notifications@gmail.com",
      SMTP_PASSWORD: "super-secret-app-pass",
    });
    assert.equal(result, "failed");
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((l) => l.includes("535")));
  assert.ok(logged.every((l) => !l.includes("super-secret-app-pass")));
});

test("production with nothing configured sends nothing and says so", async () => {
  let called = false;
  setEmailSenderForTests(async () => {
    called = true;
  });
  const original = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await sendEmail("guest@example.invalid", "RSVP", "x", { NODE_ENV: "production" }), "not-configured");
  } finally {
    console.warn = original;
  }
  assert.equal(called, false);
});

test("only sent and logged count as delivered", () => {
  assert.equal(emailDelivered("sent"), true);
  assert.equal(emailDelivered("logged"), true);
  assert.equal(emailDelivered("failed"), false);
  assert.equal(emailDelivered("not-configured"), false);
});

// TS-149
test("links' secret parts are hidden in logged emails from a production build, kept in local development", async () => {
  const token = "a".repeat(64);
  const text = `Reset: https://x.example/reset-password/${token}\nRSVP: https://x.example/rsvp/${token}\nInvite: https://x.example/invites/${token}\nVendor: https://x.example/vendor/${token}`;
  assert.equal(redactLinkTokens(text).includes(token), false);
  assert.match(redactLinkTokens(text), /\/reset-password\/\[hidden\]/);

  const logged: string[] = [];
  const original = console.log;
  console.log = (line: string) => logged.push(line);
  try {
    await sendEmail("a@example.invalid", "Hi", text, { NODE_ENV: "production", EMAIL_TRANSPORT: "log" });
    await sendEmail("a@example.invalid", "Hi", text, { NODE_ENV: "development" });
  } finally {
    console.log = original;
  }
  assert.equal(logged[0].includes(token), false);
  assert.equal(logged[1].includes(token), true);
});
