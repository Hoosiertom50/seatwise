// TS-230 / TS-232 / TS-228 item 2: unit tests for the review-9 email and "Forgot password" fixes.
// Run with `pnpm --filter @seatwise/web test`. The database is the in-memory stand-in in
// fake-database-for-tests.ts (the real counting code runs on it), the site-wide email counts are
// in-memory fakes, and the sender is fake -- nothing here touches a database or sends an email.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase, type FakeUser } from "./fake-database-for-tests";

// Real email goes out (Gmail), so every limit that only counts real sends is in play.
process.env.SMTP_USER = "seatwise.notifications@gmail.com";
process.env.SMTP_PASSWORD = "app-pass";
process.env.APP_URL = "https://seatwise.app";
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
  setUnlistedSendersForTests,
  setGuestAnswersCounterForTests,
  dailyEmailLimits,
  notificationEmailCharge,
  notificationEmailCounters,
  reserveNotificationEmail,
  actorNotificationEmailKey,
  accountDailyEmailKey,
  newestResetWaitSeconds,
  NEWEST_RESET_AFTER_SECONDS,
  newestResetSlotKey,
  senderListsRecipient,
  updateGuestForWedding,
} = db;
const { PASSWORD_RESET_LIMITS, confirmedResetNetworkCounters, countSignInAttempt, reserveEmailSend, signInFailureLimits } = await import("./rate-limit");
const { POST: forgotPassword } = await import("../app/api/v1/auth/forgot-password/route");
const { NextRequest } = await import("next/server");

const GMAIL = { NODE_ENV: "production", SMTP_USER: "seatwise.notifications@gmail.com", SMTP_PASSWORD: "app-pass" };
const WINDOW = new Date(Date.UTC(2026, 9, 7, 12));

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
let sentTo: string[] = [];
let senderFails = false;
let fake: FakeDatabase;
let restorePool: () => void;

beforeEach(() => {
  counts = new Map();
  sentTo = [];
  senderFails = false;
  fake = new FakeDatabase();
  restorePool = fake.install(pool);
  setEmailSenderForTests(async (_config, message) => {
    if (senderFails) throw Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
    sentTo.push(message.to);
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
  setAccountIsNewForTests(async () => false);
  setNewAccountsCounterForTests(counter("new-accounts"));
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

/** One "Forgot password" request for `email` from network address `from`. */
async function forgot(email: string, from: string) {
  const res = await forgotPassword(
    new NextRequest("http://localhost/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": from },
      body: JSON.stringify({ email }),
    })
  );
  const body = (await res.json()) as { sent?: boolean; alreadySent?: boolean; error?: string; message?: string };
  return { status: res.status, retryAfter: Number(res.headers.get("Retry-After") ?? 0), body };
}

// ================================================================================================
// TS-230: a stranger can no longer use up the confirmed accounts' reset budget
// ================================================================================================

type Attacker = { user: FakeUser; from: string };

/**
 * The attack from the ticket: for each of the attacker's own confirmed accounts, ask for a reset,
 * open the link, ask again -- until refused. Returns how many resets came out of the shared budget.
 * The attacker is patient: each next request waits out the 15-minute limit (3 per email), so only
 * the daily and per-network counts stop them.
 */
async function drainResets(attackers: Attacker[]): Promise<number> {
  let drawn = 0;
  for (const { user, from } of attackers) {
    for (let tries = 0; tries < 20; tries++) {
      const { status, body } = await forgot(user.email, from);
      if (status !== 200 || !body.sent || body.alreadySent) break;
      drawn++;
      fake.useLinks(user.id);
      fake.counters.delete(`pw-reset:email:${user.email}`);
    }
  }
  return drawn;
}

/** `accounts` confirmed accounts of the attacker's own, spread over `networks` (each a function giving the i-th address in it). */
function attackerAccounts(accounts: number, networks: ((i: number) => string)[]): Attacker[] {
  return Array.from({ length: accounts }, (_, i) => ({
    user: fake.addUser(`attacker${i}@catch-all.example.com`),
    from: networks[i % networks.length](i),
  }));
}
const ipv4Network = (third: number) => (i: number) => `203.0.${third}.${i + 1}`;
const ipv6Network = (group: number) => (i: number) => `2001:db8:${group.toString(16)}:${(i + 1).toString(16)}::1`;

test("TS-230: the numbers -- a confirmed account draws at most 3 resets a day (12 while locked out), 5 a day per IPv4 /24 or IPv6 /48", () => {
  assert.equal(PASSWORD_RESET_LIMITS.requestsPerConfirmedEmailDay.limit, 3);
  assert.equal(PASSWORD_RESET_LIMITS.requestsPerEmailDay.limit, 6, "unconfirmed accounts keep 6");
  assert.equal(PASSWORD_RESET_LIMITS.requestsPerEmailDayWhileLocked.limit, 12, "the locked-out allowance is unchanged");
  assert.equal(PASSWORD_RESET_LIMITS.confirmedPerIpv4BlockDay.limit, 5);
  assert.equal(PASSWORD_RESET_LIMITS.confirmedPerIpv6NetworkDay.limit, 5);
  const limits = dailyEmailLimits({});
  assert.equal(limits.resets - limits.lockedOutResets, 45, "the budget everyone not locked out shares");
  // The per-network counts only apply where email really goes out.
  const req = (from: string) => ({ headers: new Headers({ "x-forwarded-for": from }) });
  assert.deepEqual(
    confirmedResetNetworkCounters(req("203.0.113.9"), GMAIL).map((c) => [c.key, c.limit]),
    [["pw-reset:confirmed:net24:day:203.0.113.0/24", 5]]
  );
  assert.deepEqual(
    confirmedResetNetworkCounters(req("2001:db8:a:1::1"), GMAIL).map((c) => [c.key, c.limit]),
    [["pw-reset:confirmed:net48:day:2001:db8:a::/48", 5]]
  );
  assert.deepEqual(confirmedResetNetworkCounters(req("203.0.113.9"), { EMAIL_TRANSPORT: "log" }), []);
});

test("TS-230: 10 attacker accounts over 4 networks (two /24s, two /48s) draw only 20 resets -- a real user's reset still goes", async () => {
  const attackers = attackerAccounts(10, [ipv4Network(113), ipv4Network(114), ipv6Network(0xa), ipv6Network(0xb)]);
  const drawn = await quietly(() => drainResets(attackers));
  assert.equal(drawn, 20, "5 per network");
  assert.equal(counts.get("resets"), 20);
  const real = fake.addUser("forgetful@example.com");
  const { status, body } = await quietly(() => forgot(real.email, "192.0.2.10"));
  assert.equal(status, 200);
  assert.equal(body.sent, true, "the real user's reset goes out");
  assert.ok(sentTo.includes(real.email));
});

test("TS-230: 10 attacker accounts each on its own /24 draw 3 each (30) -- still short of the 45, so a real user's reset goes", async () => {
  const attackers = attackerAccounts(10, Array.from({ length: 10 }, (_, n) => ipv4Network(100 + n)));
  const drawn = await quietly(() => drainResets(attackers));
  assert.equal(drawn, 30);
  const real = fake.addUser("forgetful@example.com");
  assert.equal((await quietly(() => forgot(real.email, "192.0.2.10"))).body.sent, true);
});

test("TS-230: even with its accounts locked out (12 a day each), an attacker on 8 networks draws only 40 -- a real user's reset goes", async () => {
  const attackers = attackerAccounts(10, Array.from({ length: 8 }, (_, n) => ipv4Network(100 + n)));
  for (const { user } of attackers) fake.setCount(`login:account:${user.email}`, 100, 900);
  const drawn = await quietly(() => drainResets(attackers));
  assert.equal(drawn, 40);
  const real = fake.addUser("forgetful@example.com");
  assert.equal((await quietly(() => forgot(real.email, "192.0.2.10"))).body.sent, true);
});

test("TS-230: what it now costs -- 9 separate networks in a day and 18 accounts (2 per network) before a real user is refused", async () => {
  const attackers = attackerAccounts(18, Array.from({ length: 9 }, (_, n) => ipv4Network(100 + n)));
  const drawn = await quietly(() => drainResets(attackers));
  assert.equal(drawn, 45);
  const real = fake.addUser("forgetful@example.com");
  const refused = await quietly(() => forgot(real.email, "192.0.2.10"));
  assert.equal(refused.body.sent, false, "at 9 networks the budget is used up");
  // A locked-out user still has the 15 kept for them.
  const locked = fake.addUser("locked@example.com");
  fake.setCount(`login:account:${locked.email}`, 100, 900);
  assert.equal((await quietly(() => forgot(locked.email, "192.0.2.11"))).body.sent, true);
});

test("TS-230: a refused or unsent confirmed reset gives the network's count back", async () => {
  const user = fake.addUser("pat@example.com");
  senderFails = true;
  const { body } = await quietly(() => forgot(user.email, "203.0.113.7"));
  assert.equal(body.sent, false);
  assert.equal(fake.count("pw-reset:confirmed:net24:day:203.0.113.0/24"), 0);
  senderFails = false;
  assert.equal((await quietly(() => forgot(user.email, "203.0.113.7"))).body.sent, true);
  assert.equal(fake.count("pw-reset:confirmed:net24:day:203.0.113.0/24"), 1);
});

test("TS-230: a confirmed account at its 3 for the day gets no 'newest reset after 3 quiet hours' -- that's for unconfirmed accounts only", async () => {
  const user = fake.addUser("pat@example.com");
  fake.setCount(`pw-reset:email:day:${user.email}`, 3, 86_400);
  // The last reset went out 4 hours ago.
  fake.resetLinks.push({ userId: user.id, tokenHash: "old", createdAt: new Date(Date.now() - 4 * 3600_000), expiresAt: new Date(Date.now() - 3 * 3600_000), usedAt: null });
  const res = await quietly(() => forgot(user.email, "192.0.2.10"));
  assert.equal(res.status, 429);
  assert.equal(sentTo.length, 0);
  assert.equal(fake.count(newestResetSlotKey(user.id)), 0, "no slot is claimed for a confirmed account");
});

// ================================================================================================
// TS-228 item 2: simultaneous "Forgot password" requests after a quiet spell send only one reset
// ================================================================================================

function squattedAccount() {
  const user = fake.addUser("owner@example.com", { confirmed: false });
  // Whoever signed up with the address has used up its counts for the day.
  fake.setCount(`pw-reset:email:day:${user.email}`, PASSWORD_RESET_LIMITS.requestsPerEmailDay.limit, 86_400);
  counts.set(`to:unconfirmed-reset:${user.email}`, 3);
  return user;
}

test("TS-228: 3 simultaneous requests after a quiet spell send only 1 reset; the others wait for the quiet spell", async () => {
  const user = squattedAccount();
  const answers = await quietly(() => Promise.all(["192.0.2.1", "192.0.2.2", "198.51.100.3"].map((from) => forgot(user.email, from))));
  assert.equal(sentTo.length, 1, "one reset email");
  assert.equal(answers.filter((a) => a.status === 200 && a.body.sent).length, 1);
  const refused = answers.filter((a) => a.status === 429);
  assert.equal(refused.length, 2);
  for (const r of refused) {
    // TS-232 item 5: the wait is the quiet spell's (3 hours), not the daily count's (about a day).
    assert.ok(r.retryAfter > NEWEST_RESET_AFTER_SECONDS - 60 && r.retryAfter <= NEWEST_RESET_AFTER_SECONDS, String(r.retryAfter));
    assert.match(r.body.error ?? "", /in about 3 hours/);
  }
  // Not counted on the address's full counts.
  assert.equal(counts.get(`to:unconfirmed-reset:${user.email}`), 3);
  assert.equal(fake.count(`pw-reset:email:day:${user.email}`), PASSWORD_RESET_LIMITS.requestsPerEmailDay.limit);
});

test("TS-228: the newest-reset slot is given back when the email doesn't go out", async () => {
  const user = squattedAccount();
  senderFails = true;
  const failed = await quietly(() => forgot(user.email, "192.0.2.1"));
  assert.equal(failed.body.sent, false);
  assert.equal(fake.count(newestResetSlotKey(user.id)), 0, "slot given back");
  senderFails = false;
  const next = await quietly(() => forgot(user.email, "192.0.2.2"));
  assert.equal(next.body.sent, true);
  assert.equal(fake.count(newestResetSlotKey(user.id)), 1);
});

// ================================================================================================
// TS-232
// ================================================================================================

// --- 1. Guests' answers have a site-wide share ---

test("TS-232 item 1: emails set off by guests' answers share a fifth of the everyday allowance (48 of 240)", async () => {
  assert.equal(dailyEmailLimits({}).guestAnswers, 48);
  assert.equal(dailyEmailLimits({ EMAIL_DAILY_LIMIT: "100" }).guestAnswers, 20);
  await quietly(async () => {
    for (let i = 0; i < 48; i++) {
      assert.equal(await sendEmail(`planner${i}@example.invalid`, "s", "t", GMAIL, { toWeddingMember: true, ...notificationEmailCharge(null, `owner-${i % 2}`) }), "sent");
    }
    assert.equal(await sendEmail("planner@example.invalid", "s", "t", GMAIL, { toWeddingMember: true, ...notificationEmailCharge(null, "owner-0") }), "limited");
    // Someone's own action isn't held to it.
    assert.equal(await sendEmail("collab@example.invalid", "s", "t", GMAIL, { toWeddingMember: true, ...notificationEmailCharge("collab", "owner-0") }), "sent");
  });
  assert.equal(counts.get("guest-answers"), 48, "the refused one was given back");
});

test("TS-232 item 1: two week-old accounts (2 x (60 own + 60 from guests' answers)) can no longer use up the 240 -- others' RSVP links still go", async () => {
  await quietly(async () => {
    let sent = 0;
    for (const owner of ["a", "b"]) {
      for (let i = 0; i < 60; i++) {
        if ((await sendEmail(`m-${owner}-${i}@example.invalid`, "s", "t", GMAIL, { toWeddingMember: true, ...notificationEmailCharge(null, owner) })) === "sent") sent++;
        if ((await sendEmail(`m2-${owner}-${i}@example.invalid`, "s", "t", GMAIL, { toWeddingMember: true, account: owner })) === "sent") sent++;
      }
    }
    assert.equal(sent, 48 + 120);
    assert.equal(await sendEmail("guest@example.invalid", "Your RSVP link", "t", GMAIL, { account: "real-planner" }), "sent");
  });
  assert.ok((counts.get("everyday") ?? 0) <= 169);
});

// --- 2. "Listed for over a day" goes by when the address changed ---

test("TS-232 item 2: 'listed for over a day' goes by the guest's emailChangedAt, not updatedAt", async () => {
  let seen = "";
  restorePool();
  const target = pool as unknown as { query: unknown };
  const realQuery = target.query;
  target.query = async (sql: string) => {
    seen = sql;
    return { rows: [{ listed: true }] };
  };
  try {
    assert.equal(await senderListsRecipient("acct", "guest@example.com"), true);
  } finally {
    target.query = realQuery;
    restorePool = fake.install(pool);
  }
  assert.match(seen, /COALESCE\(g\."emailChangedAt", g\."createdAt"\) < now\(\)/);
  assert.doesNotMatch(seen, /g\."updatedAt"/);
});

/** The guest UPDATE an edit runs (the edit stops there). */
async function guestUpdateSql(input: Record<string, unknown>): Promise<{ sql: string; params: unknown[] }> {
  restorePool();
  const target = pool as unknown as { connect: unknown };
  const realConnect = target.connect;
  let update: { sql: string; params: unknown[] } | null = null;
  target.connect = async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (/^\s*UPDATE "guests" SET/.test(sql)) {
        update = { sql: sql.replace(/\s+/g, " "), params };
        throw new Error("stop here");
      }
      if (/FROM "guests" WHERE id = \$1/.test(sql)) return { rows: [{ revision: 0, headcount: 1, rsvpStatus: "PENDING", dayOfAttendance: "ATTENDING", name: "A B" }] };
      return { rows: [] };
    },
    release: () => {},
  });
  try {
    await updateGuestForWedding("g1", "w1", input).catch(() => {});
  } finally {
    target.connect = realConnect;
    restorePool = fake.install(pool);
  }
  assert.ok(update, "the edit reached its UPDATE");
  return update;
}

test("TS-232 item 2: a guest edit notes when the address really changed; other edits leave it alone", async () => {
  const emailEdit = await guestUpdateSql({ email: "new@example.com" });
  const at = emailEdit.params.indexOf("new@example.com") + 1;
  assert.ok(
    emailEdit.sql.includes(`"emailChangedAt" = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($${at}::text)) THEN now() ELSE "emailChangedAt" END`),
    emailEdit.sql
  );
  const notesEdit = await guestUpdateSql({ notes: "window seat" });
  assert.doesNotMatch(notesEdit.sql, /emailChangedAt/);
  assert.match(notesEdit.sql, /"updatedAt" = now\(\)/);
});

// --- 3. A planner's own notifications don't use up their RSVP-link allowance ---

test("TS-232 item 3: someone's own notifications count against an allowance of their own, not the one for invites and RSVP links", async () => {
  const planner = fake.addUser("planner@example.com", { createdDaysAgo: 2 });
  const counters = await notificationEmailCounters(planner.id, "w1", planner.id);
  const keys = counters.map((c) => c.key);
  assert.ok(keys.includes(actorNotificationEmailKey(planner.id)));
  assert.ok(!keys.includes(accountDailyEmailKey(planner.id)));
  assert.equal(counters.find((c) => c.key === actorNotificationEmailKey(planner.id))?.limit, 20, "first week: 20, like the account's own");
});

test("TS-232 item 3: a first-week planner with 2 collaborators can email all 20 guests their RSVP link (it was about 6)", async () => {
  const planner = fake.addUser("planner@example.com", { createdDaysAgo: 2 });
  const counters = await notificationEmailCounters(planner.id, "w1", planner.id);
  let links = 0;
  for (let guest = 0; guest < 30; guest++) {
    const link = await reserveEmailSend("rsvpEmails", planner.id);
    if (link.allowed) links++;
    // "Guest added" to each of the two collaborators.
    for (let c = 0; c < 2; c++) await reserveNotificationEmail(counters);
  }
  assert.equal(links, 20);
});

// --- 4. Counts handed back when the database fails part-way ---

/** Fails the count for `key` (its INSERT), as a busy database would. */
function failCountFor(key: string) {
  fake.failWhen = (sql, params) => (sql.startsWith(`INSERT INTO "rate_limit_counters"`) && params[0] === key ? new Error("database busy") : null);
}

test("TS-232 item 4: reserveEmailSend gives back the counts that landed when another fails", async () => {
  const planner = fake.addUser("planner@example.com");
  failCountFor(accountDailyEmailKey(planner.id));
  await assert.rejects(reserveEmailSend("invites", planner.id), /database busy/);
  assert.equal(fake.count(`email:invites:3600:${planner.id}`), 0);
  assert.equal(fake.count(`email:invites:86400:${planner.id}`), 0);
});

test("TS-232 item 4: a sign-in attempt that hits a database hiccup isn't left counted as a wrong password", async () => {
  const limits = signInFailureLimits("pat@example.com", "192.0.2.1");
  failCountFor("login:addr:192.0.2.1");
  await assert.rejects(countSignInAttempt(limits), /database busy/);
  assert.equal(fake.count("login:account-addr:pat@example.com:192.0.2.1"), 0);
  assert.equal(fake.count("login:account:pat@example.com"), 0);
});

test("TS-232 item 4: a notification email's counts are given back when one of them fails", async () => {
  const planner = fake.addUser("planner@example.com");
  const counters = await notificationEmailCounters(planner.id, "w1", planner.id);
  failCountFor(actorNotificationEmailKey(planner.id));
  await assert.rejects(reserveNotificationEmail(counters), /database busy/);
  for (const c of counters) assert.equal(fake.count(c.key), 0, c.key);
});

// --- 5. The wait a refused "Forgot password" gives ---

test("TS-232 item 5: newestResetWaitSeconds -- how long until the quiet spell is over", () => {
  const now = Date.UTC(2026, 9, 7, 12);
  assert.equal(newestResetWaitSeconds(null, now), 0);
  assert.equal(newestResetWaitSeconds(new Date(now - 4 * 3600_000), now), 0);
  assert.equal(newestResetWaitSeconds(new Date(now - 3600_000), now), 2 * 3600);
});

test("TS-232 item 5: at the day's count with the newest-reset rule 2 hours away, the 429 says about 2 hours, not about a day", async () => {
  const user = squattedAccount();
  fake.resetLinks.push({ userId: user.id, tokenHash: "old", createdAt: new Date(Date.now() - 3600_000), expiresAt: new Date(Date.now()), usedAt: new Date() });
  const res = await quietly(() => forgot(user.email, "192.0.2.1"));
  assert.equal(res.status, 429);
  assert.ok(res.retryAfter > 2 * 3600 - 60 && res.retryAfter <= 2 * 3600, String(res.retryAfter));
  assert.match(res.body.error ?? "", /in about 2 hours/);
});

// --- 6. A sent reset is never answered "Something went wrong" ---

test("TS-232 item 6: if cancelling older links fails after the reset went out, the answer is still 'sent'", async () => {
  const user = fake.addUser("pat@example.com");
  fake.failWhen = (sql) => (sql.startsWith(`UPDATE "password_reset_tokens" SET "usedAt" = now()`) ? new Error("database busy") : null);
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  let res;
  try {
    res = await quietly(async () => {
      console.error = (...args: unknown[]) => errors.push(args);
      return forgot(user.email, "192.0.2.1");
    });
  } finally {
    console.error = original;
  }
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, true);
  assert.deepEqual(sentTo, [user.email]);
  assert.ok(errors.some((e) => String(e[0]).includes("older links weren't cancelled")));
});
