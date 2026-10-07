// TS-203 / TS-213: unit tests for the email budgets other people depend on, and for notification
// emails members can turn off. Run with `pnpm --filter @seatwise/web test`. Every counter is an
// in-memory fake and the sender is fake, so nothing here touches a database or sends an email.
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clientNetworks, rateLimitAddress, rateLimitWiderNetwork } from "./client-address";

const {
  rollingTotal,
  rollingRetryAfterSeconds,
  sendEmail,
  emailMayHaveGone,
  isAmbiguousSendError,
  setEmailSenderForTests,
  setDailyEmailCounterForTests,
  setConfirmationEmailCounterForTests,
  setResetEmailCountersForTests,
  setRecipientEmailCounterForTests,
  setAccountShareCounterForTests,
  setSenderRecipientCounterForTests,
  EMAILS_PER_RECIPIENT_PER_SENDER,
  EMAILS_PER_RECIPIENT_PER_DAY,
  inviteAcceptConfirmsEmail,
  notificationEmailRecipients,
  notificationEmailBody,
} = await import("@seatwise/db");

const GMAIL = { NODE_ENV: "production", SMTP_USER: "seatwise.notifications@gmail.com", SMTP_PASSWORD: "app-pass" };
const WINDOW = new Date(Date.UTC(2026, 9, 7, 12));

// In-memory counters, by name.
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

beforeEach(() => {
  counts = new Map();
  setDailyEmailCounterForTests(counter("everyday"));
  setConfirmationEmailCounterForTests(counter("confirmations"));
  setResetEmailCountersForTests({ confirmed: counter("resets"), unconfirmed: counter("unconfirmed-resets") });
  setRecipientEmailCounterForTests({
    hit: (to, kind) => counter(`to:${kind}:${to}`).hit(),
    undo: (to, kind) => counter(`to:${kind}:${to}`).undo(),
  });
  setAccountShareCounterForTests((account) => counter(`share:${account}`));
  setSenderRecipientCounterForTests((account, to) => counter(`sender:${account}:${to}`));
});
afterEach(() => {
  setEmailSenderForTests();
  setDailyEmailCounterForTests();
  setConfirmationEmailCounterForTests();
  setResetEmailCountersForTests();
  setRecipientEmailCounterForTests();
  setAccountShareCounterForTests();
  setSenderRecipientCounterForTests();
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

// --- Rolling daily limits (account allowance, owner pool, per-address) across midnight UTC ---

test("an account's 100 sent just before midnight UTC still count just after it -- the allowance doesn't double", () => {
  // 100 sent between 11 PM and midnight UTC (7 PM Eastern) on 10-06...
  const lateHour = Date.UTC(2026, 9, 6, 23);
  const earlier = [{ startMs: lateHour, count: 100 }];
  // ...at 12:30 AM UTC on 10-07, one more is the 101st in the last 24 hours (a calendar day would say 1).
  const afterMidnight = Date.UTC(2026, 9, 7, 0);
  assert.equal(rollingTotal(1, earlier, afterMidnight, 86_400), 101);
  // And again at 10 PM on 10-07: still within the 24 hours before.
  assert.equal(rollingTotal(1, earlier, Date.UTC(2026, 9, 7, 22), 86_400), 101);
  // Only once the window after the one 24 hours later begins (midnight on 10-08) do they stop counting.
  assert.equal(rollingTotal(1, earlier, Date.UTC(2026, 9, 8, 0), 86_400), 1);
});

test("the owner's 60-a-day pool for guests' answers can't be spent twice around midnight either", () => {
  const earlier = [
    { startMs: Date.UTC(2026, 9, 6, 22), count: 30 },
    { startMs: Date.UTC(2026, 9, 6, 23), count: 30 },
  ];
  assert.ok(rollingTotal(1, earlier, Date.UTC(2026, 9, 7, 1), 86_400) > 60, "the 61st in 24 hours is over the pool");
});

test("how long until one more fits: when enough of the oldest hours have dropped out", () => {
  const now = Date.UTC(2026, 9, 7, 12, 30);
  // 10 at 2 PM yesterday, 0 since: a limit of 10 is full until that hour drops out (3 PM today).
  const windows = [{ startMs: Date.UTC(2026, 9, 6, 14), count: 10 }];
  assert.equal(rollingRetryAfterSeconds({ windows, limit: 10, nowMs: now }), 2.5 * 3600);
  // Room already: 1 second.
  assert.equal(rollingRetryAfterSeconds({ windows, limit: 11, nowMs: now }), 1);
  // Several hours: only as many have to drop out as needed.
  const spread = [
    { startMs: Date.UTC(2026, 9, 6, 13), count: 4 },
    { startMs: Date.UTC(2026, 9, 6, 16), count: 4 },
    { startMs: Date.UTC(2026, 9, 7, 12), count: 2 },
  ];
  // 10 of 10: one more fits once the 1 PM hour (4) drops out, at 2 PM today.
  assert.equal(rollingRetryAfterSeconds({ windows: spread, limit: 10, nowMs: now }), 1.5 * 3600);
  // A limit of 5: both older hours have to go (5 PM today), leaving 2.
  assert.equal(rollingRetryAfterSeconds({ windows: spread, limit: 5, nowMs: now }), 4.5 * 3600);
});

// --- IPv6 /48 ---

test("an IPv6 address is counted by its /64 and by its /48; IPv4 only by itself", () => {
  assert.equal(rateLimitAddress("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(rateLimitWiderNetwork("2001:db8:1:2:aaaa::1"), "2001:db8:1::/48");
  // Two different /64s from one free /48 tunnel share the /48 count.
  assert.equal(rateLimitWiderNetwork("2001:db8:1:ffff::9"), "2001:db8:1::/48");
  assert.notEqual(rateLimitAddress("2001:db8:1:ffff::9"), rateLimitAddress("2001:db8:1:2::1"));
  assert.equal(rateLimitWiderNetwork("[2001:DB8:1:2::1]:443"), "2001:db8:1::/48");
  assert.equal(rateLimitWiderNetwork("203.0.113.7"), null);
  assert.equal(rateLimitWiderNetwork("::ffff:203.0.113.7"), null);
  assert.equal(rateLimitWiderNetwork("unknown"), null);
  const headers = new Headers({ "x-nf-client-connection-ip": "2001:db8:abcd:12::5" });
  assert.deepEqual(clientNetworks({ headers }), { address: "2001:db8:abcd:12::/64", wider: "2001:db8:abcd::/48" });
});

// --- One account's share of the everyday allowance, and the floor kept for invites and RSVP links ---

test("no account can use more than a quarter of the everyday allowance (60 of 240), whatever kind of email", async () => {
  setEmailSenderForTests(async () => {});
  await quietly(async () => {
    for (let i = 0; i < 60; i++) {
      // Its own emails and the notifications its guests set off, together.
      const options = i % 2 ? { account: "acct-1" } : { toWeddingMember: true, account: "acct-1" };
      assert.equal(await sendEmail(`p${i}@example.invalid`, "s", "t", GMAIL, options), "sent", `email ${i}`);
    }
    assert.equal(await sendEmail("next@example.invalid", "s", "t", GMAIL, { account: "acct-1" }), "account-limited");
    // Another account is unaffected.
    assert.equal(await sendEmail("other@example.invalid", "s", "t", GMAIL, { account: "acct-2" }), "sent");
  });
  assert.equal(counts.get("share:acct-1"), 60, "the refused one was given back");
  assert.equal(counts.get("everyday"), 61);
});

test("the last fifth of the everyday allowance is kept for invites and RSVP links", async () => {
  setEmailSenderForTests(async () => {});
  counts.set("everyday", 191);
  await quietly(async () => {
    assert.equal(await sendEmail("member@example.invalid", "s", "t", GMAIL, { toWeddingMember: true }), "sent");
    // 192 used: notifications and sign-up confirmations stop...
    assert.equal(await sendEmail("member2@example.invalid", "s", "t", GMAIL, { toWeddingMember: true }), "limited");
    assert.equal(await sendEmail("new@example.invalid", "s", "t", GMAIL, { confirmation: true }), "limited");
    // ...while a planner's invite or RSVP link still goes, up to the whole 240.
    assert.equal(await sendEmail("guest@example.invalid", "s", "t", GMAIL, { account: "planner" }), "sent");
  });
  assert.equal(counts.get("everyday"), 193);
});

// --- One account's share of what an address may receive ---

test("one account can use only 3 of an address's 5 planner-sent emails", async () => {
  setEmailSenderForTests(async () => {});
  assert.equal(EMAILS_PER_RECIPIENT_PER_SENDER, 3);
  assert.equal(EMAILS_PER_RECIPIENT_PER_DAY, 5);
  await quietly(async () => {
    for (let i = 0; i < 3; i++) assert.equal(await sendEmail("aunt@example.invalid", "s", "t", GMAIL, { account: "stranger" }), "sent");
    assert.equal(await sendEmail("aunt@example.invalid", "s", "t", GMAIL, { account: "stranger" }), "recipient-limited");
    // The address's real planner can still reach them.
    assert.equal(await sendEmail("aunt@example.invalid", "s", "t", GMAIL, { account: "planner" }), "sent");
    assert.equal(await sendEmail("aunt@example.invalid", "s", "t", GMAIL, { account: "planner" }), "sent");
    // 5 in all: nobody else today.
    assert.equal(await sendEmail("aunt@example.invalid", "s", "t", GMAIL, { account: "planner" }), "recipient-limited");
  });
  assert.equal(counts.get("sender:stranger:aunt@example.invalid"), 3, "refused tries are given back");
  assert.equal(counts.get("to:planner:aunt@example.invalid"), 5);
});

// --- An unclear SMTP failure ---

test("a mail server that goes quiet after the message may have been sent is 'uncertain', and keeps its counts", async () => {
  const quiet = Object.assign(new Error("Timeout"), { code: "ETIMEDOUT", command: "CONN" });
  const dropped = Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" });
  assert.equal(isAmbiguousSendError(quiet), true);
  assert.equal(isAmbiguousSendError(dropped), true);
  // Never connected, or a clear refusal: a plain failure.
  assert.equal(isAmbiguousSendError(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" })), false);
  assert.equal(isAmbiguousSendError(Object.assign(new Error("Greeting never received"), { code: "ETIMEDOUT" })), false);
  assert.equal(isAmbiguousSendError(Object.assign(new Error("550 rejected"), { code: "EENVELOPE", responseCode: 550 })), false);
  assert.equal(isAmbiguousSendError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ESOCKET" })), false);

  setEmailSenderForTests(async () => {
    throw quiet;
  });
  const result = await quietly(() => sendEmail("x@example.invalid", "s", "t", GMAIL, { account: "acct" }));
  assert.equal(result, "uncertain");
  assert.equal(emailMayHaveGone(result), true);
  assert.equal(counts.get("everyday"), 1, "kept: it may well have gone out");
  assert.equal(counts.get("to:planner:x@example.invalid"), 1);

  setEmailSenderForTests(async () => {
    throw Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
  });
  assert.equal(await quietly(() => sendEmail("y@example.invalid", "s", "t", GMAIL)), "failed");
  assert.equal(counts.get("everyday"), 1, "a plain failure is given back");
});

// --- Accepting an emailed invite confirms the address ---

test("accepting an invite emailed to the account's own address confirms it; a copied link doesn't", () => {
  const emailed = new Date("2026-10-07T12:00:00Z");
  const base = { accountEmail: "Sam@Example.invalid", accountConfirmed: false, inviteEmail: "sam@example.invalid" };
  assert.equal(inviteAcceptConfirmsEmail({ ...base, inviteEmailedAt: emailed }), true);
  // The owner copied the link because the email didn't go out: nothing proves the inbox.
  assert.equal(inviteAcceptConfirmsEmail({ ...base, inviteEmailedAt: null }), false);
  // Another address, or one already confirmed: nothing to confirm.
  assert.equal(inviteAcceptConfirmsEmail({ ...base, accountEmail: "other@example.invalid", inviteEmailedAt: emailed }), false);
  assert.equal(inviteAcceptConfirmsEmail({ ...base, accountConfirmed: true, inviteEmailedAt: emailed }), false);
});

// --- TS-213: members who turned emails off, and the footer ---

test("notification emails skip members who turned them off, and anyone unconfirmed", () => {
  const confirmed = new Date();
  const people = [
    { id: "owner", emailVerifiedAt: confirmed, wantsEmail: true },
    { id: "aunt", emailVerifiedAt: confirmed, wantsEmail: false },
    { id: "new", emailVerifiedAt: null, wantsEmail: true },
    { id: "planner", emailVerifiedAt: confirmed, wantsEmail: true },
  ];
  assert.deepEqual(
    notificationEmailRecipients(people).map((p) => p.id),
    ["owner", "planner"]
  );
});

test("every notification email says how to open the wedding, why it came, and how to stop it", () => {
  const body = notificationEmailBody({
    text: "Sam replied to the invitation.",
    weddingName: "Ana & Bo",
    weddingUrl: "https://seatwise.example/weddings/w1",
  });
  assert.match(body, /^Sam replied to the invitation\.\n/);
  assert.match(body, /Open the wedding in Seatwise: https:\/\/seatwise\.example\/weddings\/w1/);
  assert.match(body, /You're getting this because you're a member of "Ana & Bo" on Seatwise\./);
  assert.match(body, /To stop these emails: open the wedding → Collaborators → your row, and turn off "Email me about this wedding"\./);
  // Without a usable site address or a safe wedding name, the rest is still there.
  const plain = notificationEmailBody({ text: "An update.", weddingName: null, weddingUrl: null });
  assert.doesNotMatch(plain, /Open the wedding in Seatwise/);
  assert.match(plain, /a member of a wedding on Seatwise/);
  assert.match(plain, /To stop these emails/);
});
