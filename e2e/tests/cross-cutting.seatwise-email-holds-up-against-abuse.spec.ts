/**
 * TS-178 (REQ-NON-FUNCTIONAL) — Seatwise's email can't be used up or abused (Tom's decision: tighter
 * limits, no CAPTCHA).
 * - Emails about a guest's RSVP (nobody signed in caused them) come out of the wedding's own daily
 *   pool (TS-186, Tom's decision -- they used to count toward the owner's daily allowance), and one
 *   account can create at most 10 weddings a day (copies included).
 * - TS-194: those emails also come out of a daily pool per wedding owner, across all their weddings.
 * - A password reset for an account that hasn't confirmed its address is an everyday email: it's
 *   held to its own daily count for that address (TS-194: kept apart from "Resend link", so whoever
 *   signed up with someone else's address can't use resends to block the owner's reset). A
 *   confirmed account's reset isn't.
 * - While an account is locked by the sign-in limits, the email's daily reset limit is higher (12
 *   instead of 6, TS-186; TS-230: instead of 3 for a confirmed account) -- so someone else can't
 *   lock the owner out and use up their resets, yet the inbox still can't be flooded.
 * - TS-219: those daily counts only refuse a reset while one has gone to the account in the last 3
 *   hours; after that the newest still goes (see cross-cutting.strangers-cannot-use-up-limits-meant-for-others),
 *   so the steps here first record a recent reset.
 * - A request that ends with no email sent ("Resend link", "Forgot password?") doesn't use up any
 *   allowance.
 * Tests here run with emails only logged, so limits that count only real sends -- the day's
 * ceiling, and sign-up confirmations' own share of it -- are unit-tested (email-delivery.test.mts),
 * as are the name rules (name-rules.test.mts) and what notification emails may say.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueTitle } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import {
  accountEmailCount,
  ageTestAccount,
  confirmTestAccountEmail,
  emailsToAddressToday,
  otherEmailsToAddressToday,
  ownerNotificationEmailsToday,
  passwordResetCount,
  plantPasswordResetToken,
  setAccountEmailCount,
  setEmailsToAddressToday,
  setOtherEmailsToAddressToday,
  setOwnerNotificationEmailsToday,
  setPasswordResetCount,
  setSignInFailuresForAccount,
  setWeddingNotificationEmailsToday,
  usableResetTokenCount,
  weddingNotificationEmailsThisHour,
  weddingNotificationEmailsToday,
  weddingsCreatedToday,
} from "../support/testDatabase.js";
import { waitUntilSafelyInsideUtcDay } from "../support/utcDay.js";

const ACCOUNT_EMAILS_PER_DAY = 100;
const WEDDING_RSVP_EMAILS_PER_DAY = 50;
const OWNER_RSVP_EMAILS_PER_DAY = 60;
// TS-203: an owner account in its first week.
const NEW_OWNER_RSVP_EMAILS_PER_DAY = 20;
const ANONYMOUS_EMAILS_PER_ADDRESS_PER_DAY = 3;
const UNCONFIRMED_RESETS_PER_ADDRESS_PER_DAY = 3;
const WEDDINGS_PER_DAY = 10;
const EMAILS_PER_ADDRESS_PER_DAY = 5;
// TS-230: a confirmed account's daily reset limit (an unconfirmed one's is 6).
const PASSWORD_RESETS_PER_CONFIRMED_EMAIL_PER_DAY = 3;
const PASSWORD_RESETS_PER_EMAIL_PER_DAY_WHILE_LOCKED = 12;
const SIGN_IN_FAILURES_PER_ACCOUNT = 100;
const RESENDS_PER_ACCOUNT_15_MINUTES = 3;

defineQualityTest(
  {
    id: "cross-cutting.seatwise-email-holds-up-against-abuse.rsvp-emails-use-the-weddings-own-pool-and-weddings-are-capped",
    title: "emails about guests' RSVPs come out of the wedding's own daily pool and the owner's pool across their weddings, not the owner's allowance, and an account can create at most 10 weddings a day",
    objective:
      "Confirms (TS-186, Tom's decision) that with the owner's daily email allowance used up, a guest's RSVP is still emailed -- counted in the wedding's own daily pool, with the owner's allowance untouched; that with the wedding's daily pool used up, the next RSVP still makes an in-app notification but no email (and counts nothing); that the same holds when instead the owner's daily pool across all their weddings (60, TS-194; 20 in the account's first week, TS-203) is used up; and that an account's 11th new wedding of the day, or a copy, is refused with a message saying when more can be created (TS-203: a rolling 24 hours, not 'tomorrow').",
    expectedOutcome:
      "Owner's allowance at 100: RSVP returns 200, one RSVP_RECEIVED notification, 1 email counted this hour and today for the wedding, owner's allowance still 100. Wedding's pool at 50: one more notification, the wedding's counts unchanged (50 today, 1 this hour), owner's allowance unchanged. New owner's pool at 20 (wedding's back at 0): a third notification, the wedding's count still 0 and the owner's pool still 20 (TS-203). Aged 8 days: a fourth RSVP is emailed (pool 21); at 60, a fifth notification, the wedding's count still 0 and the pool still 60. Weddings 1–10 return 201; the 11th POST and a duplicate return 429 with \"You've created a lot of weddings in the last 24 hours — you can create more in about a day.\" (TS-203: rolling).",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:rsvp", "@feature:portfolio", "@risk:high", "@suite:regression"],
  },
  async ({ account, managedWedding, weddingData, context, playwright }, testInfo) => {
    test.setTimeout(90_000);
    // TS-192: the daily counters this test sets and reads must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const baseURL = testInfo.project.use.baseURL;
    const w = managedWedding.id;
    const guestResponds = async () => {
      const added = await context.request.post(`/api/v1/weddings/${w}/guests`, { data: uniquePersonName(testInfo.workerIndex) });
      expect(added.status()).toBe(201);
      const { guest } = (await added.json()) as { guest: { id: string } };
      const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: {} });
      const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
      const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
      try {
        expect((await visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "CONFIRMED", headcount: 1 } })).status()).toBe(200);
      } finally {
        await visitor.dispose();
      }
    };
    const rsvpNotifications = async () => {
      const { notifications } = (await (await context.request.get("/api/v1/notifications")).json()) as { notifications: { type: string }[] };
      return notifications.filter((n) => n.type === "RSVP_RECEIVED").length;
    };

    await test.step("With the owner's allowance used up, a guest's RSVP is still emailed, from the wedding's own pool", async () => {
      await setAccountEmailCount(account.email, "account-day", ACCOUNT_EMAILS_PER_DAY);
      await guestResponds();
      expect(await rsvpNotifications()).toBe(1);
      expect(await weddingNotificationEmailsThisHour(w)).toBe(1);
      expect(await weddingNotificationEmailsToday(w)).toBe(1);
      expect(await ownerNotificationEmailsToday(account.email)).toBe(1);
      expect(await accountEmailCount(account.email, "account-day")).toBe(ACCOUNT_EMAILS_PER_DAY);
    });

    await test.step("With the wedding's daily pool used up, the next RSVP shows in the app but isn't emailed", async () => {
      await setAccountEmailCount(account.email, "account-day", 0);
      await setWeddingNotificationEmailsToday(w, WEDDING_RSVP_EMAILS_PER_DAY);
      await guestResponds();
      expect(await rsvpNotifications()).toBe(2);
      expect(await weddingNotificationEmailsToday(w)).toBe(WEDDING_RSVP_EMAILS_PER_DAY);
      expect(await weddingNotificationEmailsThisHour(w)).toBe(1);
      expect(await accountEmailCount(account.email, "account-day")).toBe(0);
    });

    // TS-203: an owner account in its first week has a pool of 20, so a few fresh accounts can't
    // use their own guests' answers to spend Seatwise's email.
    await test.step("A new owner's pool across their weddings is 20: used up, the next RSVP shows in the app but isn't emailed", async () => {
      await setWeddingNotificationEmailsToday(w, 0);
      await setOwnerNotificationEmailsToday(account.email, NEW_OWNER_RSVP_EMAILS_PER_DAY);
      await guestResponds();
      expect(await rsvpNotifications()).toBe(3);
      expect(await weddingNotificationEmailsToday(w)).toBe(0);
      expect(await ownerNotificationEmailsToday(account.email)).toBe(NEW_OWNER_RSVP_EMAILS_PER_DAY);
    });

    await test.step("After its first week the owner's pool is 60: at 20 the next RSVP is emailed, at 60 it isn't", async () => {
      await ageTestAccount(account.email, 8);
      await guestResponds();
      expect(await rsvpNotifications()).toBe(4);
      expect(await ownerNotificationEmailsToday(account.email)).toBe(NEW_OWNER_RSVP_EMAILS_PER_DAY + 1);
      await setWeddingNotificationEmailsToday(w, 0);
      await setOwnerNotificationEmailsToday(account.email, OWNER_RSVP_EMAILS_PER_DAY);
      await guestResponds();
      expect(await rsvpNotifications()).toBe(5);
      expect(await weddingNotificationEmailsToday(w)).toBe(0);
      expect(await ownerNotificationEmailsToday(account.email)).toBe(OWNER_RSVP_EMAILS_PER_DAY);
    });

    await test.step("An account can create 10 weddings a day; the 11th, or a copy, is refused until tomorrow", async () => {
      // TS-192: counted right before the loop and checked against that, not assumed to be 1 -- the
      // test's own wedding may have been made before a UTC midnight wait (then it's yesterday's).
      const already = await weddingsCreatedToday(account.email);
      expect(already).toBeLessThanOrEqual(1); // at most the test's own wedding
      for (let n = already + 1; n <= WEDDINGS_PER_DAY; n++) {
        const { status } = await weddingData.createWeddingRaw({ name: uniqueTitle(testInfo.workerIndex, `Cap ${n}`) });
        expect(status, `wedding ${n}`).toBe(201);
      }
      expect(await weddingsCreatedToday(account.email)).toBe(WEDDINGS_PER_DAY); // already + the ones just made
      const refused = await weddingData.createWeddingRaw({ name: uniqueTitle(testInfo.workerIndex, "Cap over") });
      expect(refused.status).toBe(429);
      // TS-203: the limit rolls over 24 hours -- with all 10 made in the last hour, more can be
      // made about a day later (never "today"/"tomorrow", which meant midnight UTC).
      expect(refused.body.error).toBe("You've created a lot of weddings in the last 24 hours — you can create more in about a day.");
      const copy = await context.request.post(`/api/v1/weddings/${w}/duplicate`, { data: {} });
      expect(copy.status()).toBe(429);
      expect(((await copy.json()) as { error: string }).error).toBe(refused.body.error);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.seatwise-email-holds-up-against-abuse.password-resets-for-unconfirmed-and-locked-accounts",
    title: "an unconfirmed account's password reset is held to its own daily count for the address -- which resends can't use up -- a confirmed one's isn't, and a locked account gets a higher -- but still limited -- daily reset limit",
    objective:
      "Confirms that a reset for an account that hasn't confirmed its address isn't sent once that address has had its 3 such resets today, one of them recently (TS-219) (saying so, and the refused request counts against nothing); that once the account is confirmed a reset to the same address goes out; that (TS-194) for another unconfirmed account whose address has used up both the emails anyone can ask for (3) and the planner-sent ones (5), a reset still goes out -- so whoever signed up with someone else's address can't block the owner taking it back; and that a confirmed account's email at its daily reset limit of 3 (TS-230), one of them recent, is refused (and not counted) -- until the account is locked by wrong passwords, when the limit is 12: refused at 12, sent at 3.",
    expectedOutcome:
      "Unconfirmed, address at 3 resets: 200 with sent false and 'This email address has had as many emails from Seatwise as it can in the last 24 hours — please try again within about a day.', no usable reset link, both per-email reset counts 0. Confirmed: 200 sent true. Second unconfirmed account with the other counts full: 200 sent true, its reset count 1. Confirmed account at 3 resets today: 429, count still 3. After locking it (sign-in refused with 429): at 12, 429 and still 12; at 3, 200 sent true and the count 4.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser, playwright }, testInfo) => {
    // TS-192: the daily counters this test sets and reads must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const baseURL = testInfo.project.use.baseURL;
    const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    const unconfirmed = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "reset-unconfirmed", { confirmEmail: false });
    const takeover = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "reset-takeover", { confirmEmail: false });
    const locked = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "reset-locked");
    const reset = (email: string) => visitor.post("/api/v1/auth/forgot-password", { data: { email } });
    try {
      await test.step("An unconfirmed account's reset isn't sent once its address has had today's resets, and counts nothing", async () => {
        await setOtherEmailsToAddressToday(unconfirmed.email, "unconfirmed-reset", UNCONFIRMED_RESETS_PER_ADDRESS_PER_DAY);
        // TS-219: one of them went out recently (its link has since run out).
        await plantPasswordResetToken(unconfirmed.email, { expired: true });
        const res = await reset(unconfirmed.email);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { sent: boolean; message: string };
        expect(body.sent).toBe(false);
        // TS-203: over the last 24 hours, rolling -- not "today"/"tomorrow".
        expect(body.message).toMatch(/within about a day/);
        expect(body.message).not.toMatch(/today|tomorrow/);
        // TS-186: it says it's this address that has had its emails, not that Seatwise has stopped.
        expect(body.message).toMatch(/This email address has had as many emails from Seatwise as it can in the last 24 hours/);
        expect(await usableResetTokenCount(unconfirmed.email)).toBe(0);
        expect(await passwordResetCount(unconfirmed.email, "per-email-15-minutes")).toBe(0);
        expect(await passwordResetCount(unconfirmed.email, "per-email-day")).toBe(0);
        expect(await otherEmailsToAddressToday(unconfirmed.email, "unconfirmed-reset")).toBe(UNCONFIRMED_RESETS_PER_ADDRESS_PER_DAY);
      });

      await test.step("Once the account is confirmed, its reset goes out to the same address", async () => {
        await confirmTestAccountEmail(unconfirmed.email);
        const res = await reset(unconfirmed.email);
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
        expect(await usableResetTokenCount(unconfirmed.email)).toBe(1);
      });

      await test.step("Resends and planner emails to the address don't block an unconfirmed account's reset", async () => {
        await setOtherEmailsToAddressToday(takeover.email, "anonymous", ANONYMOUS_EMAILS_PER_ADDRESS_PER_DAY);
        await setEmailsToAddressToday(takeover.email, EMAILS_PER_ADDRESS_PER_DAY);
        const res = await reset(takeover.email);
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
        expect(await otherEmailsToAddressToday(takeover.email, "unconfirmed-reset")).toBe(1);
        expect(await emailsToAddressToday(takeover.email)).toBe(EMAILS_PER_ADDRESS_PER_DAY);
      });

      await test.step("At the daily reset limit a reset is refused -- until the account is locked, when a higher limit applies", async () => {
        await setPasswordResetCount(locked.email, "per-email-day", PASSWORD_RESETS_PER_CONFIRMED_EMAIL_PER_DAY);
        // TS-219: one of them went out recently (its link has since run out).
        await plantPasswordResetToken(locked.email, { expired: true });
        expect((await reset(locked.email)).status()).toBe(429);
        // TS-186: the refused request isn't counted.
        expect(await passwordResetCount(locked.email, "per-email-day")).toBe(PASSWORD_RESETS_PER_CONFIRMED_EMAIL_PER_DAY);

        await setSignInFailuresForAccount(locked.email, SIGN_IN_FAILURES_PER_ACCOUNT);
        const signIn = await visitor.post("/api/v1/auth/login", { data: { email: locked.email, password: "not-the-password" } });
        expect(signIn.status()).toBe(429);
        // TS-186: still a limit while locked.
        await setPasswordResetCount(locked.email, "per-email-day", PASSWORD_RESETS_PER_EMAIL_PER_DAY_WHILE_LOCKED);
        expect((await reset(locked.email)).status()).toBe(429);
        expect(await passwordResetCount(locked.email, "per-email-day")).toBe(PASSWORD_RESETS_PER_EMAIL_PER_DAY_WHILE_LOCKED);

        await setPasswordResetCount(locked.email, "per-email-day", PASSWORD_RESETS_PER_CONFIRMED_EMAIL_PER_DAY);
        const res = await reset(locked.email);
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
        expect(await passwordResetCount(locked.email, "per-email-day")).toBe(PASSWORD_RESETS_PER_CONFIRMED_EMAIL_PER_DAY + 1);
      });
    } finally {
      await visitor.dispose();
      await unconfirmed.context.close();
      await takeover.context.close();
      await locked.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.seatwise-email-holds-up-against-abuse.resend-link-that-sends-nothing-uses-nothing",
    title: "\"Resend link\" tries that send nothing don't use up the account's resends",
    objective:
      "Confirms that while an unconfirmed account's address has had its 3 emails anyone can ask for today (TS-194), \"Resend link\" is refused each time with a message saying so, and that those refused tries don't count: once the address has room again, a resend goes out even though more tries were made than the 3 allowed in 15 minutes.",
    expectedOutcome:
      "Four resends with the address at 3: each 429 mentioning the address has had as many emails as it can in the last 24 hours. With the address back at 0: the next resend returns 200 sent true.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    // TS-192: the daily counters this test sets and reads must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const session = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "resend-gives-back", { confirmEmail: false });
    const resend = () => session.context.request.post("/api/v1/auth/verification-email", { data: {} });
    try {
      await test.step("With the address's emails used up, each resend is refused and says why", async () => {
        await setOtherEmailsToAddressToday(session.email, "anonymous", ANONYMOUS_EMAILS_PER_ADDRESS_PER_DAY);
        for (let i = 1; i <= RESENDS_PER_ACCOUNT_15_MINUTES + 1; i++) {
          const res = await resend();
          expect(res.status(), `resend ${i}`).toBe(429);
          expect(((await res.json()) as { error: string }).error, `resend ${i}`).toMatch(/as many emails from Seatwise as it can in the last 24 hours/);
        }
      });

      await test.step("Those refused tries didn't count: with room again, a resend goes out", async () => {
        await setOtherEmailsToAddressToday(session.email, "anonymous", 0);
        const res = await resend();
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
      });
    } finally {
      await session.context.close();
    }
  },
);
