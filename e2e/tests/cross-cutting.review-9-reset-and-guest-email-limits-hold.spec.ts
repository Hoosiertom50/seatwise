/**
 * TS-230 / TS-232 (REQ-NON-FUNCTIONAL) — review-9 fixes to "Forgot password" and guests' emails.
 * - A confirmed account may draw at most 3 resets a day from the budget all confirmed accounts
 *   share, and the "newest reset after 3 quiet hours" exception is for unconfirmed accounts only
 *   (the case it was made for) -- so an outsider's own accounts can't use the budget up.
 * - When the day's count is full but the newest-reset rule will let a reset go sooner, the 429
 *   gives that shorter wait, not "about a day".
 * - "This wedding has had the address for over a day" (the planner's kept 5th email to a guest)
 *   goes by when the guest's address last changed, so an edit to anything else doesn't lose it.
 * Tests here run with emails only logged, so the per-network counts of confirmed resets, the
 * shared reset budget, guests' answers' share and the simultaneous-requests case are unit-tested
 * (review-9-email-and-reset-limits.test.mts).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueToken } from "../data/ids.js";
import { signUpFreshAccountInNewContext, TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import {
  backdateGuest,
  emailsToAddressToday,
  passwordResetCount,
  plantPasswordResetToken,
  setEmailsToAddressToday,
  setPasswordResetCount,
  setUnlistedEmailsToAddressToday,
  usableResetTokenCount,
} from "../support/testDatabase.js";
import { waitUntilSafelyInsideUtcDay } from "../support/utcDay.js";

const PASSWORD_RESETS_PER_CONFIRMED_EMAIL_PER_DAY = 3;
const PASSWORD_RESETS_PER_EMAIL_PER_DAY = 6;
const NEWEST_RESET_AFTER_SECONDS = 3 * 3600;
const EMAILS_PER_ADDRESS_PER_DAY = 5;
const EMAILS_PER_ADDRESS_FROM_UNLISTED_SENDERS = 4;

defineQualityTest(
  {
    id: "cross-cutting.review-9-reset-and-guest-email-limits-hold.confirmed-resets-and-wait",
    title: "a confirmed account gets at most 3 resets a day with no quiet-spell exception, and a refused reset gives the shorter, real wait",
    objective:
      "Confirms (TS-230) that a confirmed account whose email has had its 3 resets today is refused with 429 even though no reset has gone to it for hours (the 'newest reset after 3 quiet hours' rule is for unconfirmed accounts only), counting nothing; and (TS-232) that an unconfirmed account at its 6 resets, with a reset sent just now, is refused with the wait until the newest-reset rule lets one go (about 3 hours), not about a day.",
    expectedOutcome:
      "Confirmed at 3, no recent reset: 429, the day's count still 3, no usable link. Unconfirmed at 6 with a reset just now: 429 whose message says 'in about 3 hours' and whose Retry-After is at most 10800 seconds; the day's count still 6.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser, playwright }, testInfo) => {
    // TS-192: the daily counters this test sets and reads must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const baseURL = testInfo.project.use.baseURL;
    const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    const confirmed = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "r9-reset-confirmed");
    const unconfirmed = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "r9-reset-unconfirmed", { confirmEmail: false });
    const reset = (email: string) => visitor.post("/api/v1/auth/forgot-password", { data: { email } });
    try {
      await test.step("A confirmed account at its 3 for the day is refused, however long since its last reset", async () => {
        await setPasswordResetCount(confirmed.email, "per-email-day", PASSWORD_RESETS_PER_CONFIRMED_EMAIL_PER_DAY);
        const res = await reset(confirmed.email);
        expect(res.status()).toBe(429);
        expect(await passwordResetCount(confirmed.email, "per-email-day")).toBe(PASSWORD_RESETS_PER_CONFIRMED_EMAIL_PER_DAY);
        expect(await usableResetTokenCount(confirmed.email)).toBe(0);
      });

      await test.step("An unconfirmed account at its 6, with a reset just now, is told the real wait: about 3 hours", async () => {
        await setPasswordResetCount(unconfirmed.email, "per-email-day", PASSWORD_RESETS_PER_EMAIL_PER_DAY);
        // A reset went out just now (its link has since been used up).
        await plantPasswordResetToken(unconfirmed.email, { expired: true });
        const res = await reset(unconfirmed.email);
        expect(res.status()).toBe(429);
        const wait = Number(res.headers()["retry-after"]);
        expect(wait).toBeGreaterThan(0);
        expect(wait).toBeLessThanOrEqual(NEWEST_RESET_AFTER_SECONDS);
        expect(((await res.json()) as { error: string }).error).toMatch(/in about 3 hours/);
        expect(await passwordResetCount(unconfirmed.email, "per-email-day")).toBe(PASSWORD_RESETS_PER_EMAIL_PER_DAY);
      });
    } finally {
      await visitor.dispose();
      await confirmed.context.close();
      await unconfirmed.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-9-reset-and-guest-email-limits-hold.listed-guest-edited-today",
    title: "a guest whose address the wedding has had for over a day keeps the planner's kept email even after being edited today",
    objective:
      "Confirms (TS-232) that with 4 of an address's planner-sent emails already used by senders new to it, a guest who has had that address for over a day (backdated 25 hours) and was then edited today (a private note) is still emailed a new RSVP link -- the address's 5th, kept for its own planner. Before, any edit made the guest look newly listed and the email was refused.",
    expectedOutcome:
      "The note edit returns 200. With the address's count and the new-senders' count at 4, a new RSVP link for the edited guest is emailed (emailed true); the address's count is 5.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, context }, testInfo) => {
    // TS-192: the daily counters this test sets and reads must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const w = managedWedding.id;
    const shared = `pw-guest-r9-listed-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
    const created = await context.request.post(`/api/v1/weddings/${w}/guests`, { data: { ...uniquePersonName(testInfo.workerIndex), email: shared } });
    expect(created.status()).toBe(201);
    const { guest } = (await created.json()) as { guest: { id: string } };

    await test.step("The guest has had the address for over a day, and is edited today", async () => {
      await backdateGuest(guest.id, 25);
      const edit = await context.request.patch(`/api/v1/weddings/${w}/guests/${guest.id}`, { data: { notes: "Seat near the door" } });
      expect(edit.status()).toBe(200);
    });

    await test.step("The planner still reaches them: the address's kept 5th email", async () => {
      await setEmailsToAddressToday(shared, EMAILS_PER_ADDRESS_FROM_UNLISTED_SENDERS);
      await setUnlistedEmailsToAddressToday(shared, EMAILS_PER_ADDRESS_FROM_UNLISTED_SENDERS);
      const res = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: { regenerate: true } });
      expect(res.ok()).toBe(true);
      expect(((await res.json()) as { rsvp: { emailed: boolean } }).rsvp.emailed).toBe(true);
      expect(await emailsToAddressToday(shared)).toBe(EMAILS_PER_ADDRESS_PER_DAY);
    });
  },
);
