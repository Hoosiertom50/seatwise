// TS-238 / TS-240 / TS-241 items 1-2 / TS-237 items 1, 3, 5: unit tests for the review-10 email
// fixes. Run with `pnpm --filter @seatwise/web test`. The database is the in-memory stand-in in
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
  notificationEmailCounters,
  reserveNotificationEmail,
  actorNotificationEmailKey,
  ownerNotificationEmailKey,
  newestResetSlotKey,
  hitRateLimit,
  undoRateLimitHit,
  insertNotification,
  NOTIFICATION_EMAILS_PER_OWNER_WITHOUT_ACTOR,
  NEW_OWNER_NOTIFICATION_EMAILS_WITHOUT_ACTOR,
} = db;
const {
  PASSWORD_RESET_LIMITS,
  CONFIRMATION_NETWORK_LIMITS,
  confirmationNetworkCounters,
  unconfirmedResetNetworkCounters,
  reserveEmailSend,
} = await import("./rate-limit");
const { sendFirstConfirmationEmail, setSignupEmailForTests } = await import("./signup-email");
const { rsvpEmailOutcome, rsvpEmailSendOutcome } = await import("./rsvp-email");
const { inviteSentMessage, SITE_EMAIL_LIMIT_NOTE } = await import("./email-outcome-text");
const { POST: forgotPassword } = await import("../app/api/v1/auth/forgot-password/route");
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
  setSignupEmailForTests();
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
  return { status: res.status, body };
}

const ipv4Network = (third: number) => (i: number) => `203.0.${third}.${i + 1}`;
const reqFrom = (from: string) => ({ headers: new Headers({ "x-forwarded-for": from }) });

// ================================================================================================
// TS-238: one network can no longer block a squatted address's reset, or other people's confirmations
// ================================================================================================

/** The address's real owner's account, which someone else signed up with and never confirmed. */
function squattedAccount(): FakeUser {
  const user = fake.addUser("owner@example.com", { confirmed: false });
  // Whoever signed up with the address has used up its counts for the day.
  fake.setCount(`pw-reset:email:day:${user.email}`, PASSWORD_RESET_LIMITS.requestsPerEmailDay.limit, 86_400);
  counts.set(`to:unconfirmed-reset:${user.email}`, 3);
  return user;
}

type Attacker = { user: FakeUser; from: (i: number) => string };

/**
 * The attack from the ticket: the attacker's own unconfirmed accounts (on a catch-all domain) ask
 * for resets, open each link and ask again, from the given networks -- until refused. The attacker
 * waits out the 15-minute limit, so only the daily and per-network counts stop them. Returns how
 * many reset emails went out.
 */
async function drainUnconfirmedResets(attackers: Attacker[]): Promise<number> {
  let drawn = 0;
  for (const [n, { user, from }] of attackers.entries()) {
    for (let tries = 0; tries < 20; tries++) {
      const { status, body } = await forgot(user.email, from(n * 20 + tries));
      if (status !== 200 || !body.sent || body.alreadySent) break;
      drawn++;
      fake.useLinks(user.id);
      fake.counters.delete(`pw-reset:email:${user.email}`);
    }
  }
  return drawn;
}

function attackerAccounts(accounts: number, networks: ((i: number) => string)[]): Attacker[] {
  return Array.from({ length: accounts }, (_, i) => ({
    user: fake.addUser(`squatter${i}@catch-all.example.com`, { confirmed: false }),
    from: (k: number) => networks[i % networks.length](k % 200),
  }));
}

test("TS-238: the numbers -- unconfirmed accounts' resets and confirmation emails: 5 a day per IPv4 /24 or IPv6 /48, real sends only", () => {
  assert.equal(PASSWORD_RESET_LIMITS.unconfirmedPerIpv4BlockDay.limit, 5);
  assert.equal(PASSWORD_RESET_LIMITS.unconfirmedPerIpv6NetworkDay.limit, 5);
  assert.equal(CONFIRMATION_NETWORK_LIMITS.perIpv4BlockDay.limit, 5);
  assert.equal(CONFIRMATION_NETWORK_LIMITS.perIpv6NetworkDay.limit, 5);
  assert.deepEqual(
    unconfirmedResetNetworkCounters(reqFrom("203.0.113.9"), GMAIL).map((c) => [c.key, c.limit]),
    [["pw-reset:unconfirmed:net24:day:203.0.113.0/24", 5]]
  );
  assert.deepEqual(
    unconfirmedResetNetworkCounters(reqFrom("2001:db8:a:1::1"), GMAIL).map((c) => [c.key, c.limit]),
    [["pw-reset:unconfirmed:net48:day:2001:db8:a::/48", 5]]
  );
  assert.deepEqual(
    confirmationNetworkCounters(reqFrom("203.0.113.9"), GMAIL).map((c) => [c.key, c.limit]),
    [["verify-email:sent:net24:day:203.0.113.0/24", 5]]
  );
  assert.deepEqual(
    confirmationNetworkCounters(reqFrom("2001:db8:a:1::1"), GMAIL).map((c) => [c.key, c.limit]),
    [["verify-email:sent:net48:day:2001:db8:a::/48", 5]]
  );
  assert.deepEqual(unconfirmedResetNetworkCounters(reqFrom("203.0.113.9"), { EMAIL_TRANSPORT: "log" }), []);
  assert.deepEqual(confirmationNetworkCounters(reqFrom("203.0.113.9"), { EMAIL_TRANSPORT: "log" }), []);
  const limits = dailyEmailLimits({});
  assert.equal(limits.unconfirmedResets, 24);
  assert.equal(limits.confirmations, 60);
});

test("TS-238: the ticket's attack -- 8 unconfirmed accounts from 3 addresses in one /24 draw only 5 resets, and the squatted address's owner gets theirs", async () => {
  const network = ipv4Network(113);
  const attackers = attackerAccounts(8, [(i) => network(i % 3)]);
  const drawn = await quietly(() => drainUnconfirmedResets(attackers));
  assert.equal(drawn, 5, "5 per /24 (it was 24 -- the whole share)");
  assert.equal(counts.get("unconfirmed-resets"), 5);
  const owner = squattedAccount();
  const { status, body } = await quietly(() => forgot(owner.email, "192.0.2.10"));
  assert.equal(status, 200);
  assert.equal(body.sent, true, "the address's owner gets the reset that lets them take the account back");
  assert.ok(sentTo.includes(owner.email));
});

test("TS-238: even with 5 /24s filling the unconfirmed accounts' 24, the squatted address's owner gets the newest reset -- from the resets' budget, the locked-out 15 untouched", async () => {
  const attackers = attackerAccounts(10, Array.from({ length: 5 }, (_, n) => ipv4Network(100 + n)));
  const drawn = await quietly(() => drainUnconfirmedResets(attackers));
  assert.equal(counts.get("unconfirmed-resets"), 24, "the share is full");
  assert.ok(drawn <= 25, `5 per network at most (${drawn})`);
  const resetsBefore = counts.get("resets") ?? 0;
  const owner = squattedAccount();
  const { status, body } = await quietly(() => forgot(owner.email, "192.0.2.10"));
  assert.equal(status, 200);
  assert.equal(body.sent, true, "it used to be refused: Seatwise has sent as many emails as it can");
  assert.ok(sentTo.includes(owner.email));
  assert.equal(counts.get("resets"), resetsBefore + 1, "drawn from the resets' own budget");
  assert.equal(counts.get("unconfirmed-resets"), 24, "the full share's refused count was given back");
  const limits = dailyEmailLimits({});
  assert.ok((counts.get("resets") ?? 0) <= limits.resets - limits.lockedOutResets, "the locked-out reserve is untouched");
  assert.equal(fake.count("pw-reset:confirmed:net24:day:192.0.2.0/24"), 1, "on the owner's network's slice of that budget");
});

test("TS-238: the newest-reset rule can't be used to drain the resets' budget -- one network's own unconfirmed accounts draw at most 5 from it", async () => {
  counts.set("unconfirmed-resets", 24); // the share is already full
  const attackers = attackerAccounts(20, [ipv4Network(113)]);
  const drawn = await quietly(() => drainUnconfirmedResets(attackers));
  assert.equal(drawn, 5);
  assert.equal(counts.get("resets"), 5);
  // A confirmed user's reset from elsewhere still goes.
  const real = fake.addUser("forgetful@example.com");
  assert.equal((await quietly(() => forgot(real.email, "192.0.2.10"))).body.sent, true);
});

test("TS-238: sendEmail -- an unconfirmed account's newest reset falls back to the resets' budget only when the share is full, short of the locked-out reserve", async () => {
  const limits = dailyEmailLimits(GMAIL);
  await quietly(async () => {
    // Share not full: from the share and the everyday allowance, as before.
    assert.equal(await sendEmail("a@example.invalid", "s", "t", GMAIL, { unconfirmedReset: true, newestReset: true }), "sent");
    assert.equal(counts.get("unconfirmed-resets"), 1);
    assert.equal(counts.get("everyday"), 1);
    assert.equal(counts.get("resets") ?? 0, 0);
    // Share full: an ordinary unconfirmed reset is refused...
    counts.set("unconfirmed-resets", limits.unconfirmedResets);
    assert.equal(await sendEmail("b@example.invalid", "s", "t", GMAIL, { unconfirmedReset: true }), "limited");
    // ...the newest one goes, from the resets' budget...
    assert.equal(await sendEmail("c@example.invalid", "s", "t", GMAIL, { unconfirmedReset: true, newestReset: true }), "sent");
    assert.equal(counts.get("resets"), 1);
    assert.equal(counts.get("unconfirmed-resets"), limits.unconfirmedResets);
    assert.equal(counts.get("everyday"), 1, "not counted on the everyday allowance as well");
    // ...unless the asking network's slice of that budget says no...
    assert.equal(
      await sendEmail("d@example.invalid", "s", "t", GMAIL, { unconfirmedReset: true, newestReset: true, beforeResetsBudget: async () => false }),
      "limited"
    );
    assert.equal(counts.get("resets"), 1);
    assert.equal(counts.get("to:unconfirmed-reset:d@example.invalid"), 0, "nothing stays counted");
    // ...and it stops short of the resets kept for locked-out accounts.
    counts.set("resets", limits.resets - limits.lockedOutResets);
    assert.equal(await sendEmail("e@example.invalid", "s", "t", GMAIL, { unconfirmedReset: true, newestReset: true }), "limited");
    assert.equal(counts.get("resets"), limits.resets - limits.lockedOutResets);
  });
});

/** Signs up `n` new accounts from the addresses `from(i)`; how many got their confirmation email. */
async function signUps(n: number, from: (i: number) => string, prefix: string): Promise<number> {
  setSignupEmailForTests({
    hit: hitRateLimit,
    undo: undoRateLimitHit,
    send: (user) => sendEmail(user.email, "Confirm your email for Seatwise", "t", process.env, { confirmation: true }),
  });
  let sent = 0;
  for (let i = 0; i < n; i++) {
    const user = { id: `${prefix}-${i}`, email: `${prefix}${i}@catch-all.example.com` };
    if (await sendFirstConfirmationEmail(reqFrom(from(i)), user)) sent++;
  }
  return sent;
}

test("TS-238: one /24 signing up 40 accounts gets only 5 confirmation emails out; 5 /24s get 25 -- everyone else's confirmations still go", async () => {
  await quietly(async () => {
    assert.equal(await signUps(40, ipv4Network(113), "one"), 5, "it was 30 -- half the share from one /24");
    for (let n = 0; n < 4; n++) await signUps(40, ipv4Network(100 + n), `net${n}`);
    assert.equal(counts.get("confirmations"), 25, "two /24s used to use up all 60");
    // Someone signing up from their own network still gets theirs.
    assert.equal(await signUps(1, () => "192.0.2.10", "real"), 1);
  });
});

test("TS-238: a confirmation that doesn't go out gives the network's slice back", async () => {
  senderFails = true;
  await quietly(() => signUps(3, ipv4Network(113), "x"));
  assert.equal(fake.count("verify-email:sent:net24:day:203.0.113.0/24"), 0);
  senderFails = false;
  await quietly(() => signUps(2, ipv4Network(113), "y"));
  assert.equal(fake.count("verify-email:sent:net24:day:203.0.113.0/24"), 2);
});

// ================================================================================================
// TS-240: first-week planners doing normal work all get their RSVP links out
// ================================================================================================

/**
 * One first-week planner's normal work on their wedding: `guests` guests added (each emailed their
 * RSVP link, with a "guest added" email to the one collaborator), then `answers` guests' answers
 * (each emailed to the planner and the collaborator). Returns how many RSVP links went out.
 */
async function normalWork(planner: FakeUser, guests: number, answers: number): Promise<number> {
  const weddingId = `wedding-of-${planner.id}`;
  const own = await notificationEmailCounters(planner.id, weddingId, planner.id);
  const fromGuests = await notificationEmailCounters(null, weddingId, planner.id);
  let links = 0;
  for (let g = 0; g < guests; g++) {
    const reservation = await reserveEmailSend("rsvpEmails", planner.id);
    if (reservation.allowed) {
      const result = await sendEmail(`guest${g}-${planner.id}@example.invalid`, "Your RSVP link", "t", GMAIL, { account: planner.id });
      if (result === "sent") links++;
      else await reservation.release();
    }
    const added = await reserveNotificationEmail(own);
    if (added.allowed) await sendEmail(`collab-${planner.id}@example.invalid`, "s", "t", GMAIL, { toWeddingMember: true, account: planner.id });
  }
  for (let a = 0; a < answers; a++) {
    for (const to of [planner.email, `collab-${planner.id}@example.invalid`]) {
      const answer = await reserveNotificationEmail(fromGuests);
      if (answer.allowed) await sendEmail(to, "s", "t", GMAIL, { toWeddingMember: true, forGuestsOf: planner.id });
    }
  }
  return links;
}

test("TS-240: the numbers -- first-week accounts together may use 96 of the 240 (0.4)", () => {
  assert.equal(dailyEmailLimits({}).newAccounts, 96);
  assert.equal(dailyEmailLimits({ EMAIL_DAILY_LIMIT: "100" }).newAccounts, 40);
});

test("TS-240: 3 first-week planners each doing normal work (20 RSVP links, notifications, guests' answers) all get every link out", async () => {
  setAccountIsNewForTests();
  const planners = [0, 1, 2].map((p) => fake.addUser(`planner${p}@example.com`, { createdDaysAgo: 2 }));
  const links = await quietly(async () => {
    const out: number[] = [];
    // The busiest goes first -- it used to fill the whole first-week pool (20 + 20 + 20 = 60).
    for (const planner of planners) out.push(await normalWork(planner, 20, 20));
    return out;
  });
  assert.deepEqual(links, [20, 20, 20]);
  assert.equal(counts.get("new-accounts"), 60, "only the RSVP links count toward the first-week pool");
  // A fourth new planner can still send invites and RSVP links.
  const fourth = fake.addUser("planner3@example.com", { createdDaysAgo: 1 });
  assert.equal(await quietly(() => normalWork(fourth, 20, 0)), 20);
});

test("TS-240: notifications to the wedding's members and guests' answers don't count toward the first-week pool", async () => {
  setAccountIsNewForTests(async () => true);
  await quietly(async () => {
    assert.equal(await sendEmail("m@example.invalid", "s", "t", GMAIL, { toWeddingMember: true, account: "fresh" }), "sent");
    assert.equal(await sendEmail("o@example.invalid", "s", "t", GMAIL, { toWeddingMember: true, forGuestsOf: "fresh" }), "sent");
    assert.equal(counts.get("new-accounts") ?? 0, 0);
    assert.equal(await sendEmail("g@example.invalid", "s", "t", GMAIL, { account: "fresh" }), "sent");
    assert.equal(counts.get("new-accounts"), 1, "an RSVP link or invite still does");
  });
});

// ================================================================================================
// TS-241 item 1: one owner can't use up the site-wide share for guests' answers
// ================================================================================================

test("TS-241 #1: each owner's pool for guests' answers is 12 a day (5 in the first week) -- well under the site-wide 48", async () => {
  assert.equal(NOTIFICATION_EMAILS_PER_OWNER_WITHOUT_ACTOR.limit, 12);
  assert.equal(NEW_OWNER_NOTIFICATION_EMAILS_WITHOUT_ACTOR.limit, 5);
  assert.ok(NOTIFICATION_EMAILS_PER_OWNER_WITHOUT_ACTOR.limit * 4 <= dailyEmailLimits({}).guestAnswers);
  const established = fake.addUser("owner@example.com");
  const fresh = fake.addUser("new-owner@example.com", { createdDaysAgo: 2 });
  const pool = (counters: { key: string; limit: number }[], ownerId: string) => counters.find((c) => c.key === ownerNotificationEmailKey(ownerId))?.limit;
  assert.equal(pool(await notificationEmailCounters(null, "w1", established.id), established.id), 12);
  assert.equal(pool(await notificationEmailCounters(null, "w2", fresh.id), fresh.id), 5);
});

test("TS-241 #1: one owner answering RSVPs on copies of their own links across 3 weddings sends only 12 -- every other wedding's RSVP emails still go", async () => {
  const owner = fake.addUser("owner@example.com");
  let sent = 0;
  await quietly(async () => {
    for (let answer = 0; answer < 40; answer++) {
      const counters = await notificationEmailCounters(null, `wedding-${answer % 3}`, owner.id);
      for (const to of ["owner@example.com", "c1@example.invalid", "c2@example.invalid"]) {
        const reservation = await reserveNotificationEmail(counters);
        if (reservation.allowed && (await sendEmail(to, "s", "t", GMAIL, { toWeddingMember: true, forGuestsOf: owner.id })) === "sent") sent++;
      }
    }
  });
  assert.equal(sent, 12, "it was 48 -- the whole site's share");
  assert.equal(counts.get("guest-answers"), 12);
  const other = fake.addUser("other@example.com");
  const counters = await notificationEmailCounters(null, "their-wedding", other.id);
  assert.equal((await reserveNotificationEmail(counters)).allowed, true);
  assert.equal(await quietly(() => sendEmail("other@example.com", "s", "t", GMAIL, { toWeddingMember: true, forGuestsOf: other.id })), "sent");
});

// ================================================================================================
// TS-241 item 2: Seatwise's own limit isn't shown as a plain failure
// ================================================================================================

test("TS-241 #2: 'limited' (Seatwise's own limit) is reported as such, not as 'Couldn't email'", () => {
  const url = "https://seatwise.app/rsvp/abc";
  const limited = rsvpEmailSendOutcome(url, "limited");
  assert.equal(limited.siteEmailLimited, true);
  assert.equal(limited.emailed, false);
  assert.equal(rsvpEmailOutcome(limited).siteEmailLimited, true);
  assert.equal(rsvpEmailOutcome(rsvpEmailSendOutcome(url, "failed")).siteEmailLimited, false);
  assert.equal(rsvpEmailSendOutcome(url, "account-limited").siteEmailLimited, undefined, "the account's own limit keeps its own words");
  assert.match(SITE_EMAIL_LIMIT_NOTE, /^Seatwise's email limit is reached for now.*try again later$/);
  const invite = inviteSentMessage("sam@example.invalid", { emailed: false, siteEmailLimited: true, acceptUrl: "https://seatwise.app/invites/x" });
  assert.match(invite, /^Invite created, but Seatwise's email limit is reached for now/);
  assert.match(invite, /try again later, or send sam@example\.invalid this link yourself: https:\/\/seatwise\.app\/invites\/x$/);
  assert.doesNotMatch(invite, /couldn't be sent/);
});

// ================================================================================================
// TS-237 item 1: "Forgot password" gives everything back on any way out that sends nothing
// ================================================================================================

test("TS-237 #1: a counter failing after the newest-reset slot was claimed gives the slot and every count back", async () => {
  const user = fake.addUser("pat@example.com", { confirmed: false });
  fake.failWhen = (sql, params) =>
    sql.startsWith(`INSERT INTO "rate_limit_counters"`) && params[0] === "account-email:addr:day:192.0.2.1" ? new Error("database busy") : null;
  await assert.rejects(quietly(() => forgot(user.email, "192.0.2.1")), /database busy/);
  assert.equal(fake.count(newestResetSlotKey(user.id)), 0, "the slot was given back (it used to stay for 3 hours)");
  assert.equal(fake.count(`pw-reset:email:${user.email}`), 0);
  assert.equal(fake.count(`pw-reset:email:day:${user.email}`), 0);
  assert.equal(sentTo.length, 0);
});

test("TS-237 #1: when one give-back fails, every other one is still tried", async () => {
  const user = fake.addUser("pat@example.com", { confirmed: false });
  senderFails = true;
  fake.failWhen = (sql, params) =>
    sql.startsWith(`UPDATE "rate_limit_counters"`) && params[0] === `pw-reset:email:${user.email}` ? new Error("database busy") : null;
  const { status, body } = await quietly(() => forgot(user.email, "192.0.2.1"));
  assert.equal(status, 200);
  assert.equal(body.sent, false);
  assert.equal(fake.count(newestResetSlotKey(user.id)), 0, "given back although an earlier give-back failed");
  assert.equal(fake.count(`pw-reset:email:day:${user.email}`), 0);
  assert.equal(fake.count("account-email:addr:day:192.0.2.1"), 0);
  assert.equal(fake.count(`pw-reset:email:${user.email}`), 1, "only the one whose give-back failed stays");
});

test("TS-237 #1: a sent reset keeps its counts", async () => {
  const user = fake.addUser("pat@example.com", { confirmed: false });
  assert.equal((await quietly(() => forgot(user.email, "192.0.2.1"))).body.sent, true);
  assert.equal(fake.count(newestResetSlotKey(user.id)), 1);
  assert.equal(fake.count(`pw-reset:email:day:${user.email}`), 1);
  assert.equal(fake.count("account-email:addr:day:192.0.2.1"), 1);
});

// ================================================================================================
// TS-237 item 3: a count that landed and then failed is taken back
// ================================================================================================

/** Fails the read that follows the count's INSERT for `key` (the INSERT itself succeeds). */
function failReadAfterInsertFor(key: string) {
  fake.failWhen = (sql, params) =>
    sql.startsWith("SELECT") && sql.includes(`FROM "rate_limit_counters"`) && params[0] === key ? new Error("database busy") : null;
}

test("TS-237 #3: hitRateLimit takes its own count back when the read after it fails -- daily (rolling) and short (sliding) limits", async () => {
  failReadAfterInsertFor("k:day");
  await assert.rejects(hitRateLimit("k:day", 5, 86_400), /database busy/);
  assert.equal(fake.count("k:day"), 0);
  failReadAfterInsertFor("k:quarter");
  await assert.rejects(hitRateLimit("k:quarter", 5, 900), /database busy/);
  assert.equal(fake.count("k:quarter"), 0);
  fake.failWhen = () => null;
  assert.equal((await hitRateLimit("k:quarter", 5, 900)).allowed, true);
  assert.equal(fake.count("k:quarter"), 1);
});

test("TS-237 #3: reserveNotificationEmail leaves nothing counted when one count's read fails after its INSERT", async () => {
  const planner = fake.addUser("planner@example.com");
  const counters = await notificationEmailCounters(planner.id, "w1", planner.id);
  failReadAfterInsertFor(actorNotificationEmailKey(planner.id));
  await assert.rejects(reserveNotificationEmail(counters), /database busy/);
  for (const c of counters) assert.equal(fake.count(c.key), 0, c.key);
});

// ================================================================================================
// TS-237 item 5: a notification locks in the same order as deleting a wedding
// ================================================================================================

/** Runs insertNotification against a stand-in client; returns every statement, in order. */
async function insertNotificationStatements(answers: { owner: string; user: boolean; member: boolean; failInsert?: boolean }) {
  restorePool();
  const target = pool as unknown as { connect: unknown };
  const realConnect = target.connect;
  const seen: string[] = [];
  target.connect = async () => ({
    query: async (sqlText: string) => {
      const sql = sqlText.replace(/\s+/g, " ").trim();
      seen.push(sql);
      if (/FROM "weddings" WHERE id = \$1 FOR KEY SHARE/.test(sql)) return { rows: [{ ownerId: answers.owner }], rowCount: 1 };
      if (/FROM "users" WHERE id = \$1 FOR KEY SHARE/.test(sql)) return answers.user ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (/FROM "wedding_collaborators" .* FOR KEY SHARE/.test(sql)) return answers.member ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (/^INSERT INTO "notifications"/.test(sql) && answers.failInsert) throw new Error("database busy");
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  });
  try {
    const written = await insertNotification("w1", "u2", "GUEST_ADDED", "Ann Lee was added.").catch((err: Error) => err);
    return { seen, written };
  } finally {
    target.connect = realConnect;
    restorePool = fake.install(pool);
  }
}

test("TS-237 #5: a notification locks the wedding, then the recipient, then their access row, then inserts -- in one transaction", async () => {
  const { seen, written } = await insertNotificationStatements({ owner: "owner-1", user: true, member: true });
  assert.equal(written, true);
  const at = (re: RegExp) => seen.findIndex((s) => re.test(s));
  const begin = at(/^BEGIN/);
  const wedding = at(/^SELECT "ownerId" FROM "weddings" WHERE id = \$1 FOR KEY SHARE$/);
  const recipient = at(/^SELECT 1 FROM "users" WHERE id = \$1 FOR KEY SHARE$/);
  const access = at(/^SELECT 1 FROM "wedding_collaborators" WHERE "weddingId" = \$1 AND "userId" = \$2 FOR KEY SHARE$/);
  const insert = at(/^INSERT INTO "notifications"/);
  const commit = at(/^COMMIT$/);
  assert.ok(begin === 0, seen.join("\n"));
  assert.ok(begin < wedding && wedding < recipient && recipient < access && access < insert && insert < commit, seen.join("\n"));
  // The INSERT no longer takes locks of its own in another order (no sub-query on the access row).
  assert.doesNotMatch(seen[insert], /wedding_collaborators/);
});

test("TS-237 #5: someone no longer a member gets nothing written; a failed INSERT rolls back", async () => {
  const removed = await insertNotificationStatements({ owner: "owner-1", user: true, member: false });
  assert.equal(removed.written, false);
  assert.ok(!removed.seen.some((s) => s.startsWith('INSERT INTO "notifications"')));
  assert.ok(removed.seen.includes("COMMIT"));
  const owner = await insertNotificationStatements({ owner: "u2", user: true, member: false });
  assert.equal(owner.written, true, "the owner needs no access row");
  const failed = await insertNotificationStatements({ owner: "owner-1", user: true, member: true, failInsert: true });
  assert.ok(failed.written instanceof Error);
  assert.ok(failed.seen.includes("ROLLBACK"));
});
