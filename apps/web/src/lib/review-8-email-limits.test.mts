// TS-219 / TS-220 / TS-223: unit tests for the review-8 email-limit fixes. Run with
// `pnpm --filter @seatwise/web test`. Every counter is an in-memory fake and the sender is fake, so
// nothing here touches a database or sends an email.
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rateLimitIpv4Block } from "./client-address";
import { inviteSentMessage, rsvpMaybeSentNote } from "./email-outcome-text";

const {
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
  EMAILS_PER_RECIPIENT_FROM_UNLISTED_SENDERS,
  UNCONFIRMED_RESETS_PER_RECIPIENT_PER_DAY,
  notificationEmailCharge,
  newestResetMayGo,
  NEWEST_RESET_AFTER_SECONDS,
} = await import("@seatwise/db");
const {
  ACCOUNT_EMAIL_LIMITS,
  LOGIN_LIMITS,
  RSVP_LIMITS,
  SIGNUP_LIMITS,
  VENDOR_LINK_LIMITS,
  accountEmailCounters,
  perNetworkCounters,
  rsvpNetworkCounters,
  signInFailureLimits,
  vendorLinkNetworkCounters,
} = await import("./rate-limit");
const { rsvpEmailOutcome, rsvpEmailSendOutcome } = await import("./rsvp-email");
const { sendFirstConfirmationEmail, setSignupEmailForTests } = await import("./signup-email");

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
// Which accounts are in their first week, and which have long had which addresses, per test.
let newAccounts = new Set<string>();
let listed = new Set<string>();

beforeEach(() => {
  counts = new Map();
  newAccounts = new Set();
  listed = new Set();
  setEmailSenderForTests(async () => {});
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
  setUnlistedSendersForTests({ counter: (to) => counter(`unlisted:${to}`), listed: async (account, to) => listed.has(`${account}:${to}`) });
  setGuestAnswersCounterForTests(counter("guest-answers"));
});
afterEach(() => {
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

// --- 1. Guests' answers don't use up the owner's own share ---

test("TS-219: a guest's answer is charged to nobody's share; someone's own action to their account", () => {
  assert.deepEqual(notificationEmailCharge(null, "owner-1"), { forGuestsOf: "owner-1" });
  assert.deepEqual(notificationEmailCharge("collab-1", "owner-1"), { account: "collab-1" });
});

test("TS-219: emails set off by guests' answers leave the owner's own share untouched, so their invites still go", async () => {
  await quietly(async () => {
    // TS-232: as many as guests' answers' site-wide share allows (48 of 240).
    for (let i = 0; i < 48; i++) {
      const result = await sendEmail(`planner${i}@example.invalid`, "s", "t", GMAIL, { toWeddingMember: true, ...notificationEmailCharge(null, "owner") });
      assert.equal(result, "sent", `guest-caused email ${i}`);
    }
    assert.equal(counts.get("share:owner") ?? 0, 0, "nothing charged to the owner's share");
    // The owner's own invite still goes (before this fix it was "account-limited").
    assert.equal(await sendEmail("invitee@example.invalid", "s", "t", GMAIL, { account: "owner" }), "sent");
  });
  assert.equal(counts.get("share:owner"), 1);
  // Still bounded by the site's allowance (counted there), short of the planner floor.
  assert.equal(counts.get("everyday"), 49);
});

// --- 2. Accounts in their first week share one pool ---

test("TS-219 / TS-240: accounts in their first week together use at most 0.4 of the everyday allowance (96 of 240)", async () => {
  assert.equal(dailyEmailLimits({}).newAccounts, 96);
  for (let a = 0; a < 12; a++) newAccounts.add(`fresh-${a}`);
  await quietly(async () => {
    // 12 fresh accounts, 8 each (well within each one's own 20): 96 go out...
    for (let a = 0; a < 12; a++) {
      for (let i = 0; i < 8; i++) {
        assert.equal(await sendEmail(`g-${a}-${i}@example.invalid`, "s", "t", GMAIL, { account: `fresh-${a}` }), "sent");
      }
    }
    // ...then the next first-week account is refused, as Seatwise's limit...
    newAccounts.add("fresh-12");
    assert.equal(await sendEmail("g-12@example.invalid", "s", "t", GMAIL, { account: "fresh-12" }), "limited");
    // ...but (TS-240) an email a first-week owner's guests set off, or a notification to the
    // wedding's own members, isn't held to that share...
    assert.equal(await sendEmail("p@example.invalid", "s", "t", GMAIL, { toWeddingMember: true, forGuestsOf: "fresh-0" }), "sent");
    assert.equal(await sendEmail("p2@example.invalid", "s", "t", GMAIL, { toWeddingMember: true, account: "fresh-1" }), "sent");
    // ...and an older account's email still goes.
    assert.equal(await sendEmail("g-old@example.invalid", "s", "t", GMAIL, { account: "old" }), "sent");
  });
  assert.equal(counts.get("new-accounts"), 96, "refused ones were given back");
  assert.equal(counts.get("everyday"), 99);
  assert.equal(counts.get("to:planner:g-12@example.invalid"), 0, "nothing stays counted for a refused email");
});

test("TS-219: the first-week pool only counts real sends", async () => {
  newAccounts.add("fresh");
  await quietly(async () => {
    assert.equal(await sendEmail("g@example.invalid", "s", "t", { EMAIL_TRANSPORT: "log" }, { account: "fresh" }), "logged");
  });
  assert.equal(counts.get("new-accounts") ?? 0, 0);
});

// --- 3. Room kept on an address for its own planner ---

test("TS-219: two unrelated accounts can't fill a stranger's 5 -- the last is kept for the planner whose wedding has long had the address", async () => {
  assert.equal(EMAILS_PER_RECIPIENT_FROM_UNLISTED_SENDERS, 4);
  const aunt = "aunt@example.invalid";
  listed.add(`planner:${aunt}`);
  await quietly(async () => {
    for (let i = 0; i < 3; i++) assert.equal(await sendEmail(aunt, "s", "t", GMAIL, { account: "stranger-1" }), "sent");
    assert.equal(await sendEmail(aunt, "s", "t", GMAIL, { account: "stranger-2" }), "sent");
    // The 5th: refused for a second unrelated account...
    assert.equal(await sendEmail(aunt, "s", "t", GMAIL, { account: "stranger-2" }), "recipient-limited");
    // ...but the real planner still reaches them.
    assert.equal(await sendEmail(aunt, "s", "t", GMAIL, { account: "planner" }), "sent");
    // 5 in all: nobody else in the 24 hours, the planner included.
    assert.equal(await sendEmail(aunt, "s", "t", GMAIL, { account: "planner" }), "recipient-limited");
  });
  assert.equal(counts.get(`unlisted:${aunt}`), 4, "refused tries are given back");
  assert.equal(counts.get(`to:planner:${aunt}`), 5);
  assert.equal(counts.get(`sender:stranger-2:${aunt}`), 1);
});

test("TS-219: one unrelated account alone still leaves room for a newly added guest's planner", async () => {
  const guest = "cousin@example.invalid";
  await quietly(async () => {
    for (let i = 0; i < 3; i++) assert.equal(await sendEmail(guest, "s", "t", GMAIL, { account: "stranger" }), "sent");
    // A planner who added this guest just now isn't "listed" yet, and still gets the 4th.
    assert.equal(await sendEmail(guest, "s", "t", GMAIL, { account: "new-planner" }), "sent");
  });
});

// --- 4. IPv6 /48 counts for sign-up, sign-in, RSVP and vendor links; IPv4 /24 for account emails ---

const ipv6 = (address: string) => ({ headers: new Headers({ "x-nf-client-connection-ip": address }) });
const ipv4 = (address: string) => ({ headers: new Headers({ "x-nf-client-connection-ip": address }) });

test("TS-219: sign-up, RSVP and vendor-link limits count an IPv6 source's /48 as well as its /64; IPv4 only itself", () => {
  const req = ipv6("2001:db8:7:42::9");
  assert.deepEqual(perNetworkCounters(req, (n) => `signup:addr:hour:${n}`, SIGNUP_LIMITS.perAddressHour, SIGNUP_LIMITS.perWiderNetworkHour), [
    { key: "signup:addr:hour:2001:db8:7:42::/64", limit: 30, windowSeconds: 3600 },
    { key: "signup:addr:hour:net48:2001:db8:7::/48", limit: 60, windowSeconds: 3600 },
  ]);
  assert.deepEqual(SIGNUP_LIMITS.perWiderNetworkDay, { limit: 200, windowSeconds: 86_400 });
  // Two /64s in one /48 share the /48 count.
  const other = perNetworkCounters(ipv6("2001:db8:7:ffff::1"), (n) => `x:${n}`, SIGNUP_LIMITS.perAddressHour, SIGNUP_LIMITS.perWiderNetworkHour);
  assert.equal(other[1].key, "x:net48:2001:db8:7::/48");
  assert.deepEqual(rsvpNetworkCounters(req), [
    { key: "rsvp:addr:2001:db8:7:42::/64", ...RSVP_LIMITS.perAddress },
    { key: "rsvp:addr:net48:2001:db8:7::/48", limit: 300, windowSeconds: 600 },
  ]);
  assert.deepEqual(vendorLinkNetworkCounters(req), [
    { key: "vendor-link:addr:2001:db8:7:42::/64", ...VENDOR_LINK_LIMITS.perAddress },
    { key: "vendor-link:addr:net48:2001:db8:7::/48", limit: 300, windowSeconds: 600 },
  ]);
  // IPv4: the key it always had, and nothing more.
  assert.deepEqual(rsvpNetworkCounters(ipv4("203.0.113.7")), [{ key: "rsvp:addr:203.0.113.7", ...RSVP_LIMITS.perAddress }]);
});

test("TS-219: wrong passwords are also counted per IPv6 /48", () => {
  const keys = (limits: { key: string }[]) => limits.map((l) => l.key);
  const limits = signInFailureLimits("Sam@Example.invalid", "2001:db8:7:42::/64", { widerNetwork: "2001:db8:7::/48" });
  assert.deepEqual(keys(limits), [
    "login:account-addr:sam@example.invalid:2001:db8:7:42::/64",
    "login:account:sam@example.invalid",
    "login:addr:2001:db8:7:42::/64",
    "login:net48:2001:db8:7::/48",
  ]);
  assert.deepEqual(limits[3], { key: "login:net48:2001:db8:7::/48", ...LOGIN_LIMITS.failuresPerWiderNetwork });
  assert.deepEqual(LOGIN_LIMITS.failuresPerWiderNetwork, { limit: 100, windowSeconds: 900 });
  // IPv4: unchanged.
  assert.equal(signInFailureLimits("sam@example.invalid", "203.0.113.7").length, 3);
});

test("TS-219: account emails from IPv4 are also counted per /24 -- only where email really goes out", () => {
  assert.equal(rateLimitIpv4Block("203.0.113.77"), "203.0.113.0/24");
  assert.equal(rateLimitIpv4Block("2001:db8::1"), null);
  assert.equal(rateLimitIpv4Block("unknown"), null);
  assert.equal(rateLimitIpv4Block("300.1.1.1"), null);
  assert.deepEqual(accountEmailCounters(ipv4("203.0.113.77"), GMAIL), [
    { key: "account-email:addr:day:203.0.113.77", ...ACCOUNT_EMAIL_LIMITS.perAddressDay },
    { key: "account-email:net24:day:203.0.113.0/24", limit: 30, windowSeconds: 86_400 },
  ]);
  // Neighbouring addresses share it.
  assert.equal(accountEmailCounters(ipv4("203.0.113.5"), GMAIL)[1].key, "account-email:net24:day:203.0.113.0/24");
  // The "log" transport (this machine, CI) never counts it -- every test signs up from neighbouring addresses.
  assert.equal(accountEmailCounters(ipv4("203.0.113.77"), { EMAIL_TRANSPORT: "log" }).length, 1);
  // IPv6 keeps its /64 and /48.
  assert.equal(accountEmailCounters(ipv6("2001:db8:7:42::9"), GMAIL).length, 2);
});

// --- 5. "May have been sent" ---

test("TS-219: an RSVP email the email service may have taken is reported as 'may have been sent', not a failure", () => {
  const url = "https://seatwise.example/rsvp/abc";
  const maybe = rsvpEmailSendOutcome(url, "uncertain");
  assert.deepEqual(maybe, { url, emailed: false, emailFailed: true, uncertain: true });
  assert.equal(rsvpEmailOutcome(maybe).uncertain, true);
  assert.equal(rsvpEmailOutcome(rsvpEmailSendOutcome(url, "failed")).uncertain, false);
  assert.deepEqual(rsvpEmailSendOutcome(url, "sent"), { url, emailed: true, emailFailed: false });
  assert.equal(rsvpEmailSendOutcome(url, "recipient-limited").recipientLimited, true);
  assert.equal(rsvpEmailSendOutcome(url, "account-limited").emailLimitedToday, true);

  assert.match(rsvpMaybeSentNote("sam@example.invalid"), /^The email to sam@example\.invalid may have been sent/);
  assert.doesNotMatch(rsvpMaybeSentNote("sam@example.invalid"), /Couldn't/);
});

test("TS-219: the invite screen says 'may have been sent' for an unclear send, and still hands over the link", () => {
  const acceptUrl = "https://seatwise.example/invites/abc";
  assert.equal(inviteSentMessage("sam@example.invalid", { emailed: true }), "Invite sent to sam@example.invalid.");
  const maybe = inviteSentMessage("sam@example.invalid", { emailed: false, uncertain: true, acceptUrl });
  assert.match(maybe, /may have been sent/);
  assert.doesNotMatch(maybe, /couldn't be sent/);
  assert.ok(maybe.endsWith(acceptUrl));
  assert.match(inviteSentMessage("sam@example.invalid", { emailed: false, acceptUrl }), /couldn't be sent\. Send them this link yourself: https/);
});

// --- 6. "Forgot password" can't be used to keep an address's owner from their reset ---

test("TS-219: the newest reset may go past full daily counts once none has gone for 3 hours", () => {
  assert.equal(NEWEST_RESET_AFTER_SECONDS, 3 * 3600);
  const now = Date.UTC(2026, 9, 7, 15);
  assert.equal(newestResetMayGo(null, now), true);
  assert.equal(newestResetMayGo(new Date(now - 2 * 3600_000), now), false);
  assert.equal(newestResetMayGo(new Date(now - 3 * 3600_000), now), true);
});

test("TS-219: with the address's 3 unconfirmed resets used, the newest after a quiet spell still goes, uncounted on the address", async () => {
  const owner = "owner@example.invalid";
  counts.set(`to:unconfirmed-reset:${owner}`, UNCONFIRMED_RESETS_PER_RECIPIENT_PER_DAY);
  await quietly(async () => {
    // A reset went out recently: refused, as before.
    assert.equal(await sendEmail(owner, "s", "t", GMAIL, { unconfirmedReset: true }), "recipient-limited");
    // None for 3 hours: this one goes.
    assert.equal(await sendEmail(owner, "s", "t", GMAIL, { unconfirmedReset: true, newestReset: true }), "sent");
  });
  assert.equal(counts.get(`to:unconfirmed-reset:${owner}`), UNCONFIRMED_RESETS_PER_RECIPIENT_PER_DAY, "not counted on the address");
  assert.equal(counts.get("unconfirmed-resets"), 1, "still counted in the site's share for these");
});

// --- TS-220: sign-up's confirmation email is best effort ---

test("TS-220: if the counters fail after the account is made, sign-up's email reports false and gives back what it counted", async () => {
  const given: string[] = [];
  let calls = 0;
  setSignupEmailForTests({
    hit: async (key) => {
      if (calls++ === 1) throw new Error("database busy");
      return { allowed: true, windowStart: WINDOW, key } as unknown as { allowed: boolean; windowStart: Date };
    },
    undo: async (key) => {
      given.push(key);
    },
    send: async () => {
      throw new Error("should not be reached");
    },
  });
  const req = ipv6("2001:db8:7:42::9");
  const sent = await quietly(() => sendFirstConfirmationEmail(req, { id: "u1", email: "new@example.invalid" }));
  assert.equal(sent, false);
  assert.deepEqual(given, ["account-email:addr:day:2001:db8:7:42::/64"], "the count that was made is given back");
});

test("TS-220: if sending itself throws, sign-up's email reports false and gives every count back", async () => {
  const given: string[] = [];
  setSignupEmailForTests({
    hit: async () => ({ allowed: true, windowStart: WINDOW }),
    undo: async (key) => {
      given.push(key);
    },
    send: async () => {
      throw new Error("token table unreachable");
    },
  });
  const sent = await quietly(() => sendFirstConfirmationEmail(ipv4("203.0.113.7"), { id: "u1", email: "new@example.invalid" }));
  assert.equal(sent, false);
  assert.deepEqual(given, ["account-email:addr:day:203.0.113.7"]);
});

test("TS-220: a confirmation that goes out keeps its counts", async () => {
  const given: string[] = [];
  setSignupEmailForTests({
    hit: async () => ({ allowed: true, windowStart: WINDOW }),
    undo: async (key) => {
      given.push(key);
    },
    send: async () => "logged",
  });
  assert.equal(await sendFirstConfirmationEmail(ipv4("203.0.113.7"), { id: "u1", email: "new@example.invalid" }), true);
  assert.deepEqual(given, []);
});

// --- TS-227: counts already taken are given back when a later one refuses or fails ---

test("TS-227: when the /48 refuses, the /64 count already taken is given back", async () => {
  const { networkRateLimitOr429, setNetworkCountForTests } = await import("./rate-limit");
  const given: string[] = [];
  setNetworkCountForTests(async (key) => ({
    limited: key.includes("net48:") ? NextResponseLike429() : null,
    giveBack: async () => {
      given.push(key);
    },
  }));
  try {
    const limited = await networkRateLimitOr429(rsvpNetworkCounters(ipv6("2001:db8:7:42::9")));
    assert.equal(limited?.status, 429);
    assert.deepEqual(given, ["rsvp:addr:2001:db8:7:42::/64"], "the /64's count goes back; the /48 gave back its own");
  } finally {
    setNetworkCountForTests();
  }
});

test("TS-227: when a later counter fails, the counts already taken are given back and the error still surfaces", async () => {
  const { networkRateLimitOr429, setNetworkCountForTests } = await import("./rate-limit");
  const given: string[] = [];
  setNetworkCountForTests(async (key) => {
    if (key.includes("net48:")) throw new Error("database busy");
    return {
      limited: null,
      giveBack: async () => {
        given.push(key);
      },
    };
  });
  try {
    await assert.rejects(networkRateLimitOr429(rsvpNetworkCounters(ipv6("2001:db8:7:42::9"))), /database busy/);
    assert.deepEqual(given, ["rsvp:addr:2001:db8:7:42::/64"]);
  } finally {
    setNetworkCountForTests();
  }
});

test("TS-227: when nothing refuses, no count is given back", async () => {
  const { networkRateLimitOr429, setNetworkCountForTests } = await import("./rate-limit");
  const given: string[] = [];
  setNetworkCountForTests(async (key) => ({
    limited: null,
    giveBack: async () => {
      given.push(key);
    },
  }));
  try {
    assert.equal(await networkRateLimitOr429(rsvpNetworkCounters(ipv6("2001:db8:7:42::9"))), null);
    assert.deepEqual(given, []);
  } finally {
    setNetworkCountForTests();
  }
});

test("TS-227: a sign-up count that lands after another one failed is still given back", async () => {
  const given: string[] = [];
  setSignupEmailForTests({
    hit: async (key) => {
      // The /64 is slow and succeeds; the /48 fails at once.
      if (key.includes("net48")) throw new Error("database busy");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { allowed: true, windowStart: WINDOW };
    },
    undo: async (key) => {
      given.push(key);
    },
    send: async () => {
      throw new Error("should not be reached");
    },
  });
  const sent = await quietly(() => sendFirstConfirmationEmail(ipv6("2001:db8:7:42::9"), { id: "u1", email: "new@example.invalid" }));
  assert.equal(sent, false);
  assert.deepEqual(given, ["account-email:addr:day:2001:db8:7:42::/64"]);
});

/** A minimal stand-in for a 429 response (only its status is read). */
function NextResponseLike429() {
  return { status: 429 } as unknown as import("next/server").NextResponse;
}
