/**
 * TS-219 (REQ-NON-FUNCTIONAL) — limits that one source could use up for everyone else (review 8).
 * - An IPv6 source is held to its /48 as well as its /64 for sign-ups, wrong passwords and the
 *   public RSVP link (a free tunnel hands out a /48 -- 65,536 /64s, each with its own limits).
 * - Of the 5 planner-sent emails an address may get in 24 hours, senders whose weddings haven't had
 *   the address for over a day share 4: the last is kept for the planner whose guest list really
 *   has them, so two unrelated accounts (3 + 2) can't block them.
 * - "Forgot password": once no reset has gone to the account for 3 hours, the newest goes out even
 *   when the day's counts for the address are full -- so whoever signed up with someone else's
 *   address can't use those counts up and keep the owner from taking the account back.
 * Tests here run with emails only logged, so the limits that count only real sends -- guests'
 * answers no longer charged to the owner's share, the first-week accounts' combined share, the
 * IPv4 /24 count of account emails -- and the "may have been sent" wording are unit-tested
 * (review-8-email-limits.test.mts).
 */

import { randomBytes, randomInt } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueToken } from "../data/ids.js";
import { signUpFreshAccountInNewContext, TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import {
  backdateGuest,
  emailsToAddressToday,
  otherEmailsToAddressToday,
  passwordResetCount,
  setEmailsToAddressToday,
  setIpv6NetworkCount,
  setOtherEmailsToAddressToday,
  setPasswordResetCount,
  setUnlistedEmailsToAddressToday,
  unlistedEmailsToAddressToday,
  usableResetTokenCount,
} from "../support/testDatabase.js";
import { waitUntilSafelyInsideUtcDay } from "../support/utcDay.js";

const SIGNUPS_PER_IPV6_48_PER_HOUR = 60;
const SIGN_IN_FAILURES_PER_IPV6_48 = 100;
const RSVP_REQUESTS_PER_IPV6_48 = 300;
const EMAILS_PER_ADDRESS_PER_DAY = 5;
const EMAILS_PER_ADDRESS_FROM_UNLISTED_SENDERS = 4;
const UNCONFIRMED_RESETS_PER_ADDRESS_PER_DAY = 3;
const PASSWORD_RESETS_PER_EMAIL_PER_DAY = 6;

/** A random /48 in the documentation-only range, as the app writes it, and an address in one of its /64s. */
function testIpv6Network() {
  const group = (randomInt(0xfffe) + 1).toString(16);
  return {
    network48: `2001:db8:${group}::/48`,
    address: (subnet: number) => `2001:db8:${group}:${subnet.toString(16)}::${randomInt(1, 0xffff).toString(16)}`,
  };
}

defineQualityTest(
  {
    id: "cross-cutting.strangers-cannot-use-up-limits-meant-for-others.ipv6-48-counts",
    title: "an IPv6 /48 is limited as a whole for sign-ups, wrong passwords and RSVP-link requests, whichever of its /64s they come from",
    objective:
      "Confirms (TS-219) that once a /48 has had its 60 sign-ups in the hour, a sign-up from a /64 in it that has had none is refused with 429 while one from another /48 succeeds; that once a /48 has had 100 wrong passwords, a sign-in from a fresh /64 in it is refused with 429 while another /48 gets the ordinary 401; and that once a /48 has made 300 RSVP-link requests in ten minutes, a fresh /64 in it is refused with 429 while another /48 still sees the RSVP page.",
    expectedOutcome:
      "Sign-up from the full /48: 429; from another /48: 201. Wrong password from the full /48: 429; from another /48: 401. RSVP link from the full /48: 429; from another /48: 200 with status OPEN.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, context, playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const from = (address: string) => playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": address } });
    const clients: Awaited<ReturnType<typeof from>>[] = [];
    const client = async (address: string) => {
      const c = await from(address);
      clients.push(c);
      return c;
    };
    const signUp = (c: Awaited<ReturnType<typeof from>>) =>
      c.post("/api/v1/auth/signup", {
        data: {
          name: `Playwright Tester ${uniqueToken(testInfo.workerIndex)}`,
          email: `pw-tester-v6-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`,
          password: randomBytes(12).toString("hex"),
        },
      });

    try {
      await test.step("Sign-ups: a full /48 refuses even a /64 in it that hasn't signed anyone up", async () => {
        const full = testIpv6Network();
        await setIpv6NetworkCount(full.network48, "signups-hour", SIGNUPS_PER_IPV6_48_PER_HOUR);
        expect((await signUp(await client(full.address(1)))).status()).toBe(429);
        expect((await signUp(await client(testIpv6Network().address(1)))).status()).toBe(201);
      });

      await test.step("Wrong passwords: a full /48 refuses a fresh /64 in it; another /48 is unaffected", async () => {
        const full = testIpv6Network();
        await setIpv6NetworkCount(full.network48, "sign-in-failures", SIGN_IN_FAILURES_PER_IPV6_48);
        const probe = { email: `nobody-v6-48-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`, password: "guess" };
        expect((await (await client(full.address(2))).post("/api/v1/auth/login", { data: probe })).status()).toBe(429);
        expect((await (await client(testIpv6Network().address(2))).post("/api/v1/auth/login", { data: probe })).status()).toBe(401);
      });

      await test.step("RSVP link: a full /48 refuses a fresh /64 in it; another /48 still sees the page", async () => {
        const w = managedWedding.id;
        const created = await context.request.post(`/api/v1/weddings/${w}/guests`, { data: uniquePersonName(testInfo.workerIndex) });
        expect(created.status()).toBe(201);
        const { guest } = (await created.json()) as { guest: { id: string } };
        const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: {} });
        const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
        const full = testIpv6Network();
        await setIpv6NetworkCount(full.network48, "rsvp-requests", RSVP_REQUESTS_PER_IPV6_48);
        expect((await (await client(full.address(3))).get(`/api/v1/rsvp/${token}`)).status()).toBe(429);
        const elsewhere = await (await client(testIpv6Network().address(3))).get(`/api/v1/rsvp/${token}`);
        expect(elsewhere.status()).toBe(200);
        expect(((await elsewhere.json()) as { rsvp: { status: string } }).rsvp.status).toBe("OPEN");
      });
    } finally {
      await Promise.all(clients.map((c) => c.dispose()));
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.strangers-cannot-use-up-limits-meant-for-others.address-kept-for-its-own-planner",
    title: "senders whose weddings have only just added an address share 4 of its 5 emails a day; the last is kept for a planner whose guest list has had it for over a day",
    objective:
      "Confirms (TS-219) that with 4 of an address's planner-sent emails already used by senders new to it, a guest just added with that address isn't emailed (recipientLimited, the address's count unchanged at 4), while the RSVP link for a guest who has had that address for over a day (backdated 25 hours) is emailed -- the address's 5th.",
    expectedOutcome:
      "First guest with the address: emailed true. With both the address's count and the new-senders' count at 4: a second guest just added with it reports emailed false and recipientLimited true, counts unchanged. The first guest backdated 25 hours: a new RSVP link is emailed (emailed true), the address's count 5, the new-senders' count still 4.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, context }, testInfo) => {
    // TS-192: the daily counters this test sets and reads must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const w = managedWedding.id;
    const shared = `pw-guest-reserved-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
    const addGuest = async () => {
      const res = await context.request.post(`/api/v1/weddings/${w}/guests`, { data: { ...uniquePersonName(testInfo.workerIndex), email: shared } });
      expect(res.status()).toBe(201);
      return (await res.json()) as { guest: { id: string }; rsvpEmail: { emailed: boolean; recipientLimited: boolean } };
    };

    const first = await addGuest();
    expect(first.rsvpEmail.emailed).toBe(true);

    await test.step("Senders new to the address have used their 4: a guest just added with it isn't emailed", async () => {
      await setEmailsToAddressToday(shared, EMAILS_PER_ADDRESS_FROM_UNLISTED_SENDERS);
      await setUnlistedEmailsToAddressToday(shared, EMAILS_PER_ADDRESS_FROM_UNLISTED_SENDERS);
      const second = await addGuest();
      expect(second.rsvpEmail.emailed).toBe(false);
      expect(second.rsvpEmail.recipientLimited).toBe(true);
      expect(await emailsToAddressToday(shared)).toBe(EMAILS_PER_ADDRESS_FROM_UNLISTED_SENDERS);
      expect(await unlistedEmailsToAddressToday(shared)).toBe(EMAILS_PER_ADDRESS_FROM_UNLISTED_SENDERS);
    });

    await test.step("A planner whose guest has had the address for over a day still reaches it: the 5th", async () => {
      await backdateGuest(first.guest.id, 25);
      const res = await context.request.post(`/api/v1/weddings/${w}/guests/${first.guest.id}/rsvp-link`, { data: { regenerate: true } });
      expect(res.ok()).toBe(true);
      expect(((await res.json()) as { rsvp: { emailed: boolean } }).rsvp.emailed).toBe(true);
      expect(await emailsToAddressToday(shared)).toBe(EMAILS_PER_ADDRESS_PER_DAY);
      expect(await unlistedEmailsToAddressToday(shared)).toBe(EMAILS_PER_ADDRESS_FROM_UNLISTED_SENDERS);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.strangers-cannot-use-up-limits-meant-for-others.newest-reset-after-a-quiet-spell",
    title: "with no reset for 3 hours, the newest password reset goes out even when the address's daily reset counts are full -- and isn't counted on them",
    objective:
      "Confirms (TS-219) that for an account that hasn't confirmed its address, with no reset sent to it recently but its address's 3 unconfirmed resets and its email's 6 resets for the day already used (as someone who signed up with another person's address could arrange), \"Forgot password?\" still sends a reset, without adding to either count -- and that asking again while that link works sends nothing new.",
    expectedOutcome:
      "Reset: 200 with sent true; one usable reset link; the address's unconfirmed-reset count still 3 and the email's daily reset count still 6. Asked again: 200 sent true, still one usable link, counts unchanged.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser, playwright }, testInfo) => {
    // TS-192: the daily counters this test sets and reads must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const baseURL = testInfo.project.use.baseURL;
    const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    const squatted = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "reset-squatted", { confirmEmail: false });
    const reset = () => visitor.post("/api/v1/auth/forgot-password", { data: { email: squatted.email } });
    try {
      await setOtherEmailsToAddressToday(squatted.email, "unconfirmed-reset", UNCONFIRMED_RESETS_PER_ADDRESS_PER_DAY);
      await setPasswordResetCount(squatted.email, "per-email-day", PASSWORD_RESETS_PER_EMAIL_PER_DAY);

      await test.step("The newest reset after a quiet spell goes out, and isn't counted", async () => {
        const res = await reset();
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
        expect(await usableResetTokenCount(squatted.email)).toBe(1);
        expect(await otherEmailsToAddressToday(squatted.email, "unconfirmed-reset")).toBe(UNCONFIRMED_RESETS_PER_ADDRESS_PER_DAY);
        expect(await passwordResetCount(squatted.email, "per-email-day")).toBe(PASSWORD_RESETS_PER_EMAIL_PER_DAY);
      });

      await test.step("Asking again while that link works sends nothing new", async () => {
        const res = await reset();
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
        expect(await usableResetTokenCount(squatted.email)).toBe(1);
        expect(await passwordResetCount(squatted.email, "per-email-day")).toBe(PASSWORD_RESETS_PER_EMAIL_PER_DAY);
      });
    } finally {
      await visitor.dispose();
      await squatted.context.close();
    }
  },
);
