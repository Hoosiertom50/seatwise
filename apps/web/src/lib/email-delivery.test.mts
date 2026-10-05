// TS-132: unit tests for how Seatwise picks an email service and reports what happened
// (packages/db/src/email.ts). Run with `pnpm --filter @seatwise/web test`. The real SMTP/Resend
// sender is swapped for a fake, so nothing here ever sends an email.
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

const {
  resolveEmailTransport,
  sendEmail,
  emailDelivered,
  setEmailSenderForTests,
  redactLinkTokens,
  setDailyEmailCounterForTests,
  dailyEmailLimits,
  setRecipientEmailCounterForTests,
  EMAILS_PER_RECIPIENT_PER_DAY,
} = await import("@seatwise/db");

// TS-163: the daily email ceiling's counter lives in the database; here it's an in-memory one.
let sentToday = 0;
// TS-171: and so does the per-recipient one.
let toAddress = new Map<string, number>();
beforeEach(() => {
  sentToday = 0;
  toAddress = new Map();
  setRecipientEmailCounterForTests({
    hit: async (to) => {
      const n = (toAddress.get(to.toLowerCase()) ?? 0) + 1;
      toAddress.set(to.toLowerCase(), n);
      return n;
    },
    undo: async (to) => {
      toAddress.set(to.toLowerCase(), (toAddress.get(to.toLowerCase()) ?? 1) - 1);
    },
  });
  setDailyEmailCounterForTests({
    hit: async () => ++sentToday,
    undo: async () => {
      sentToday--;
    },
  });
});
afterEach(() => {
  setEmailSenderForTests();
  setDailyEmailCounterForTests();
  setRecipientEmailCounterForTests();
});

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

// TS-163: one Gmail account sends everything; Gmail suspends accounts that go over its daily limit.
const GMAIL = { NODE_ENV: "production", SMTP_USER: "seatwise.notifications@gmail.com", SMTP_PASSWORD: "app-pass" };

test("the daily ceiling defaults to 400 everyday emails, with 80 more kept for password resets", () => {
  assert.deepEqual(dailyEmailLimits({}), { everyday: 400, essential: 480 });
  assert.deepEqual(dailyEmailLimits({ EMAIL_DAILY_LIMIT: "100" }), { everyday: 100, essential: 180 });
  assert.deepEqual(dailyEmailLimits({ EMAIL_DAILY_LIMIT: "nonsense" }), { everyday: 400, essential: 480 });
});

test("over the daily ceiling, everyday emails aren't sent (and don't use up the reset headroom); resets still go", async () => {
  const sent: string[] = [];
  setEmailSenderForTests(async (_config, message) => {
    sent.push(message.to);
  });
  const env = { ...GMAIL, EMAIL_DAILY_LIMIT: "2" };
  assert.equal(await sendEmail("a@example.invalid", "s", "t", env), "sent");
  assert.equal(await sendEmail("b@example.invalid", "s", "t", env), "sent");
  assert.equal(await sendEmail("c@example.invalid", "s", "t", env), "limited");
  assert.equal(await sendEmail("d@example.invalid", "s", "t", env), "limited");
  assert.equal(sentToday, 2, "refused emails are taken back off the count");
  assert.equal(emailDelivered("limited"), false);
  // A password reset still goes out, up to the extra headroom.
  assert.equal(await sendEmail("me@example.invalid", "Reset", "t", env, { essential: true }), "sent");
  assert.deepEqual(sent, ["a@example.invalid", "b@example.invalid", "me@example.invalid"]);
});

test("the log transport used locally and in CI never counts against the ceiling", async () => {
  assert.equal(await sendEmail("a@example.invalid", "s", "t", { EMAIL_TRANSPORT: "log", NODE_ENV: "production", EMAIL_DAILY_LIMIT: "1" }), "logged");
  assert.equal(sentToday, 0);
});

// TS-164: "confirm your email" links are hidden in production logs too.
test("email-confirmation links' secret parts are hidden like the other link types", () => {
  const token = "ab".repeat(32);
  assert.equal(
    redactLinkTokens(`Confirm here: https://seatwise.example/verify-email/${token}`),
    "Confirm here: https://seatwise.example/verify-email/[hidden]"
  );
});

// TS-172: an explicit "log" wins over real credentials, so a test run can never send real email.
test("EMAIL_TRANSPORT=log wins even when Gmail or Resend credentials are present", () => {
  assert.equal(resolveEmailTransport({ EMAIL_TRANSPORT: "log", SMTP_USER: "u@example.invalid", SMTP_PASSWORD: "p" }).kind, "log");
  assert.equal(resolveEmailTransport({ EMAIL_TRANSPORT: "log", RESEND_API_KEY: "re_x" }).kind, "log");
});

/** Runs `fn` with console.warn (and console.log) silenced -- refused sends warn on purpose. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { warn, log } = console;
  console.warn = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

// TS-171: the reserved headroom is for password resets only.
test("with the everyday allowance used up, an email-confirmation (an everyday email) isn't sent but a password reset is", async () => {
  setEmailSenderForTests(async () => {});
  const env = { ...GMAIL, EMAIL_DAILY_LIMIT: "1" };
  await quietly(async () => {
    assert.equal(await sendEmail("a@example.invalid", "Confirm your email for Seatwise", "t", env), "sent");
    assert.equal(await sendEmail("b@example.invalid", "Confirm your email for Seatwise", "t", env), "limited");
    assert.equal(await sendEmail("c@example.invalid", "Reset your Seatwise password", "t", env, { essential: true }), "sent");
  });
  assert.equal(sentToday, 2);
});

test("one address gets at most 5 capped emails a day, however it's written; other addresses are unaffected", async () => {
  const sent: string[] = [];
  setEmailSenderForTests(async (_config, message) => {
    sent.push(message.to);
  });
  assert.equal(EMAILS_PER_RECIPIENT_PER_DAY, 5);
  await quietly(async () => {
    for (let i = 1; i <= 5; i++) {
      const to = i % 2 ? "Victim@example.invalid" : "victim@example.invalid";
      assert.equal(await sendEmail(to, "s", "t", GMAIL), "sent", `email ${i}`);
    }
    assert.equal(await sendEmail("victim@example.invalid", "s", "t", GMAIL), "recipient-limited");
    assert.equal(await sendEmail("VICTIM@example.invalid", "s", "t", GMAIL), "recipient-limited");
    assert.equal(await sendEmail("someone-else@example.invalid", "s", "t", GMAIL), "sent");
  });
  assert.equal(sent.length, 6);
  assert.equal(sentToday, 6, "refused emails don't use up the day's allowance");
  assert.equal(emailDelivered("recipient-limited"), false);
});

test("password resets and notifications to a wedding's own members aren't held to the per-address cap", async () => {
  setEmailSenderForTests(async () => {});
  await quietly(async () => {
    for (let i = 0; i < EMAILS_PER_RECIPIENT_PER_DAY; i++) await sendEmail("me@example.invalid", "s", "t", GMAIL);
    assert.equal(await sendEmail("me@example.invalid", "s", "t", GMAIL), "recipient-limited");
    assert.equal(await sendEmail("me@example.invalid", "Reset", "t", GMAIL, { essential: true }), "sent");
    assert.equal(await sendEmail("me@example.invalid", "Seatwise: update", "t", GMAIL, { toWeddingMember: true }), "sent");
  });
});

test("the per-address cap counts with the log transport too, so local runs and CI behave like the live site", async () => {
  const env = { EMAIL_TRANSPORT: "log", NODE_ENV: "production" };
  await quietly(async () => {
    for (let i = 0; i < EMAILS_PER_RECIPIENT_PER_DAY; i++) assert.equal(await sendEmail("x@example.invalid", "s", "t", env), "logged");
    assert.equal(await sendEmail("x@example.invalid", "s", "t", env), "recipient-limited");
  });
  assert.equal(sentToday, 0, "the daily ceiling still only counts real sends");
});

test("an email refused by the daily ceiling doesn't count toward its recipient's cap", async () => {
  setEmailSenderForTests(async () => {});
  const env = { ...GMAIL, EMAIL_DAILY_LIMIT: "1" };
  await quietly(async () => {
    await sendEmail("first@example.invalid", "s", "t", env);
    assert.equal(await sendEmail("y@example.invalid", "s", "t", env), "limited");
  });
  assert.equal(toAddress.get("y@example.invalid"), 0);
});
