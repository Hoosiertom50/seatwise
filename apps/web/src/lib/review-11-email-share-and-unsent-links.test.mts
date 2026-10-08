// TS-249 / TS-253 item 2 / TS-248 item 2: unit tests for the review-11 email-limit fixes. Run with
// `pnpm --filter @seatwise/web test`. The database is the in-memory stand-in in
// fake-database-for-tests.ts, the site-wide email counts are in-memory fakes, and the sender is
// fake -- nothing here touches a database or sends an email.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { FakeDatabase } from "./fake-database-for-tests";

// Real email goes out (Gmail), so every limit that only counts real sends is in play.
process.env.SMTP_USER = "seatwise.notifications@gmail.com";
process.env.SMTP_PASSWORD = "app-pass";
process.env.APP_URL = "https://seatwise.app";
process.env.JWT_SECRET = randomBytes(32).toString("hex");
delete process.env.EMAIL_TRANSPORT;

const db = await import("@seatwise/db");
const {
  pool,
  sendEmail,
  setEmailSenderForTests,
  setDailyEmailCounterForTests,
  setConfirmationEmailCounterForTests,
  setResetEmailCountersForTests,
  setRecipientEmailCounterForTests,
  setAccountShareCounterForTests,
  setSenderRecipientCounterForTests,
  setAccountIsNewForTests,
  setNewAccountsCounterForTests,
  setNewAccountNotificationsCounterForTests,
  setUnlistedSendersForTests,
  setGuestAnswersCounterForTests,
  dailyEmailLimits,
} = db;
const { POST: forgotPassword } = await import("../app/api/v1/auth/forgot-password/route");
const { POST: resendConfirmation } = await import("../app/api/v1/auth/verification-email/route");
const { signToken } = await import("./auth");
const { NextRequest } = await import("next/server");

const GMAIL = { NODE_ENV: "production", SMTP_USER: "seatwise.notifications@gmail.com", SMTP_PASSWORD: "app-pass" };
const WINDOW = new Date(Date.UTC(2026, 9, 8, 12));

// The site-wide email counts (in-memory, by name).
let counts = new Map<string, number>();
const counter = (name: string) => ({
  hit: async () => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return { count: counts.get(name)!, windowStart: WINDOW };
  },
  undo: async () => {
    counts.set(name, (counts.get(name) ?? 1) - 1);
  },
});
let sent: string[] = [];
let senderFails = false;
let newAccounts = new Set<string>();
let fake: FakeDatabase;
let restorePool: () => void;

beforeEach(() => {
  counts = new Map();
  sent = [];
  senderFails = false;
  newAccounts = new Set();
  fake = new FakeDatabase();
  restorePool = fake.install(pool);
  setEmailSenderForTests(async (_config, message) => {
    if (senderFails) throw Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
    sent.push(message.to);
  });
  setDailyEmailCounterForTests(counter("everyday"));
  setConfirmationEmailCounterForTests(counter("confirmations"));
  setResetEmailCountersForTests({ confirmed: counter("resets"), unconfirmed: counter("unconfirmed-resets") });
  setRecipientEmailCounterForTests({
    hit: (to, kind) => counter(`to:${kind}:${to}`).hit(),
    undo: (to, kind) => counter(`to:${kind}:${to}`).undo(),
  });
  setAccountShareCounterForTests((account) => counter(`share:${account}`));
  setSenderRecipientCounterForTests((account, to) => counter(`sender:${account}:${to}`));
  setAccountIsNewForTests(async (account) => newAccounts.has(account));
  setNewAccountsCounterForTests(counter("new-accounts"));
  setNewAccountNotificationsCounterForTests(counter("new-account-notifications"));
  setUnlistedSendersForTests({ counter: (to) => counter(`unlisted:${to}`), listed: async () => true });
  setGuestAnswersCounterForTests(counter("guest-answers"));
});
afterEach(() => {
  restorePool();
  setEmailSenderForTests();
  setDailyEmailCounterForTests();
  setConfirmationEmailCounterForTests();
  setResetEmailCountersForTests();
  setRecipientEmailCounterForTests();
  setAccountShareCounterForTests();
  setSenderRecipientCounterForTests();
  setAccountIsNewForTests();
  setNewAccountsCounterForTests();
  setNewAccountNotificationsCounterForTests();
  setUnlistedSendersForTests();
  setGuestAnswersCounterForTests();
});

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { warn, log, error } = console;
  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
    console.error = error;
  }
}

/** A notification email `account` sets off to a member of its wedding. */
const notify = (account: string, to: string) => sendEmail(to, "New comment", "t", GMAIL, { toWeddingMember: true, account });

// ================================================================================================
// TS-249: first-week accounts' notifications to their weddings' members share 48 a day, together
// ================================================================================================

test("TS-249: the first-week accounts' notifications share is 20% of the everyday allowance (48 of 240)", () => {
  assert.equal(dailyEmailLimits({}).newAccountNotifications, 48);
  assert.equal(dailyEmailLimits({ EMAIL_DAILY_LIMIT: "100" }).newAccountNotifications, 20);
  // The first-week pool for invites and RSVP links is unchanged.
  assert.equal(dailyEmailLimits({}).newAccounts, 96);
});

test("TS-249: ten fresh accounts notifying each other stop at 48, and confirmations and resets still go out", async () => {
  let notified = 0;
  await quietly(async () => {
    for (let a = 0; a < 10; a++) {
      const account = `fresh-${a}`;
      newAccounts.add(account);
      for (let i = 0; i < 20; i++) if ((await notify(account, `member${i % 3}-${a}@example.com`)) === "sent") notified++;
    }
  });
  assert.equal(notified, 48);
  assert.equal(counts.get("new-account-notifications"), 48);
  // Refused ones are given back, so the everyday count holds only what went out.
  assert.equal(counts.get("everyday"), 48);
  // Notifications don't use the first-week pool for invites and RSVP links.
  assert.equal(counts.get("new-accounts") ?? 0, 0);

  const results = await quietly(async () => ({
    confirmation: await sendEmail("newcomer@example.com", "Confirm", "t", GMAIL, { confirmation: true }),
    unconfirmedReset: await sendEmail("someone@example.com", "Reset", "t", GMAIL, { unconfirmedReset: true }),
    confirmedReset: await sendEmail("member@example.com", "Reset", "t", GMAIL, { essential: true }),
    // A fresh planner's invite still goes, from the first-week pool.
    invite: await sendEmail("guest@example.com", "Invite", "t", GMAIL, { account: "fresh-0" }),
  }));
  assert.deepEqual(results, { confirmation: "sent", unconfirmedReset: "sent", confirmedReset: "sent", invite: "sent" });
  assert.equal(counts.get("new-accounts"), 1);
});

test("TS-249: established accounts' notifications aren't counted in the first-week share, and still go when it's full", async () => {
  newAccounts.add("fresh");
  counts.set("new-account-notifications", 48);
  const results = await quietly(async () => [
    await notify("fresh", "a@example.com"),
    await notify("established", "b@example.com"),
    await notify("established", "c@example.com"),
  ]);
  assert.deepEqual(results, ["limited", "sent", "sent"]);
  assert.equal(counts.get("new-account-notifications"), 48);
});

test("TS-249: a first-week notification that fails to send is given back to the share", async () => {
  newAccounts.add("fresh");
  senderFails = true;
  assert.equal(await quietly(() => notify("fresh", "a@example.com")), "failed");
  assert.equal(counts.get("new-account-notifications"), 0);
  senderFails = false;
  assert.equal(await quietly(() => notify("fresh", "a@example.com")), "sent");
  assert.equal(counts.get("new-account-notifications"), 1);
});

// ================================================================================================
// TS-253 item 2: an unsent reset link that can't be deleted never answers "already sent"
// ================================================================================================

async function forgot(email: string) {
  const res = await forgotPassword(
    new NextRequest("http://localhost/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ email }),
    })
  );
  return { status: res.status, body: (await res.json()) as { sent?: boolean; alreadySent?: boolean } };
}

test("TS-253: when deleting an unsent link keeps failing, it's marked used, so asking again sends a new one", async () => {
  const user = fake.addUser("pat@example.com");
  senderFails = true;
  fake.failWhen = (sql) => (sql.startsWith(`DELETE FROM "password_reset_tokens"`) ? new Error("database busy") : null);
  const first = await quietly(() => forgot(user.email));
  assert.equal(first.status, 200);
  assert.equal(first.body.sent, false);
  assert.equal(fake.resetLinks.length, 1);
  assert.ok(fake.resetLinks[0].usedAt, "the unsent link no longer works");
  assert.equal(fake.log.filter((sql) => sql.startsWith(`DELETE FROM "password_reset_tokens"`)).length, 2, "the delete was tried twice");

  // The mail server is back: the next request sends a new link, not "already sent".
  senderFails = false;
  fake.failWhen = () => null;
  fake.counters.delete(`pw-reset:email:${user.email}`);
  const second = await quietly(() => forgot(user.email));
  assert.equal(second.status, 200);
  assert.equal(second.body.sent, true);
  assert.notEqual(second.body.alreadySent, true);
  assert.deepEqual(sent, [user.email]);
});

test("TS-253: a delete that fails once is tried again, and the unsent link is gone", async () => {
  const user = fake.addUser("pat@example.com");
  senderFails = true;
  let failures = 0;
  fake.failWhen = (sql) => (sql.startsWith(`DELETE FROM "password_reset_tokens"`) && failures++ === 0 ? new Error("database busy") : null);
  const res = await quietly(() => forgot(user.email));
  assert.equal(res.status, 200);
  assert.equal(fake.resetLinks.length, 0);
});

// ================================================================================================
// TS-248 item 2: "Resend link" gives back every count when a counter fails part-way
// ================================================================================================

test("TS-248: when a counter fails part-way through \"Resend link\", the counts taken before it are given back", async () => {
  const user = fake.addUser("new@example.com", { confirmed: false, createdDaysAgo: 0 });
  const token = await signToken({ sub: user.id, email: user.email, sessionVersion: 0 });
  // The last counts (this network's slice of the confirmations' share) can't be reached.
  fake.failWhen = (sql, params) =>
    sql.startsWith(`INSERT INTO "rate_limit_counters"`) && String(params[0]).startsWith("verify-email:sent:") ? new Error("database busy") : null;
  const req = new NextRequest("http://localhost/api/v1/auth/verification-email", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "198.51.100.7" },
  });
  await quietly(() => assert.rejects(resendConfirmation(req), /database busy/));
  // Counts were taken before the failing one ...
  assert.ok(fake.log.some((sql) => sql.startsWith(`INSERT INTO "rate_limit_counters"`)));
  // ... and every one of them was given back.
  for (const key of fake.counters.keys()) assert.equal(fake.count(key), 0, `${key} was given back`);
  assert.deepEqual(sent, []);
});
