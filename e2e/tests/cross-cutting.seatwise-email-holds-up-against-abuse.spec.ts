/**
 * TS-178 (REQ-NON-FUNCTIONAL) — Seatwise's email can't be used up or abused (Tom's decision: tighter
 * limits, no CAPTCHA).
 * - Emails about a guest's RSVP (nobody signed in caused them) count toward the wedding owner's
 *   daily email allowance, and one account can create at most 10 weddings a day (copies included).
 * - A password reset for an account that hasn't confirmed its address is an everyday email: it's
 *   held to that address's daily share. A confirmed account's reset isn't.
 * - While an account is locked by the sign-in limits, asking for a reset doesn't count against the
 *   email's daily reset limit -- so someone else can't lock the owner out and use up their resets.
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
  confirmTestAccountEmail,
  emailsToAddressToday,
  passwordResetCount,
  setAccountEmailCount,
  setEmailsToAddressToday,
  setPasswordResetCount,
  setSignInFailuresForAccount,
  usableResetTokenCount,
  weddingNotificationEmailsThisHour,
  weddingsCreatedToday,
} from "../support/testDatabase.js";

const ACCOUNT_EMAILS_PER_DAY = 100;
const WEDDINGS_PER_DAY = 10;
const EMAILS_PER_ADDRESS_PER_DAY = 5;
const PASSWORD_RESETS_PER_EMAIL_PER_DAY = 6;
const SIGN_IN_FAILURES_PER_ACCOUNT = 100;
const RESENDS_PER_ACCOUNT_15_MINUTES = 3;

defineQualityTest(
  {
    id: "cross-cutting.seatwise-email-holds-up-against-abuse.rsvp-emails-use-the-owners-allowance-and-weddings-are-capped",
    title: "emails about guests' RSVPs count toward the wedding owner's daily allowance, and an account can create at most 10 weddings a day",
    objective:
      "Confirms that with the owner's daily email allowance used up, a guest's RSVP still makes an in-app notification but no notification email (and counts nothing), that with one email left it is emailed and uses that last one; and that an account's 11th new wedding of the day, or a copy, is refused with a message saying more can be created tomorrow.",
    expectedOutcome:
      "Allowance at 100: RSVP returns 200, one more RSVP_RECEIVED notification, 0 notification emails counted, allowance still 100. Allowance at 99: 1 notification email counted, allowance 100. Weddings 1–10 return 201; the 11th POST and a duplicate return 429 with \"You've created a lot of weddings today — you can create more tomorrow.\"",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:rsvp", "@feature:portfolio", "@risk:high", "@suite:regression"],
  },
  async ({ account, managedWedding, weddingData, context, playwright }, testInfo) => {
    test.setTimeout(90_000);
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

    await test.step("With the owner's allowance used up, a guest's RSVP shows in the app but isn't emailed", async () => {
      await setAccountEmailCount(account.email, "account-day", ACCOUNT_EMAILS_PER_DAY);
      await guestResponds();
      expect(await rsvpNotifications()).toBe(1);
      expect(await weddingNotificationEmailsThisHour(w)).toBe(0);
      expect(await accountEmailCount(account.email, "account-day")).toBe(ACCOUNT_EMAILS_PER_DAY);
    });

    await test.step("With one email left, the next guest's RSVP is emailed and uses it", async () => {
      await setAccountEmailCount(account.email, "account-day", ACCOUNT_EMAILS_PER_DAY - 1);
      await guestResponds();
      expect(await rsvpNotifications()).toBe(2);
      expect(await weddingNotificationEmailsThisHour(w)).toBe(1);
      expect(await accountEmailCount(account.email, "account-day")).toBe(ACCOUNT_EMAILS_PER_DAY);
    });

    await test.step("An account can create 10 weddings a day; the 11th, or a copy, is refused until tomorrow", async () => {
      const already = await weddingsCreatedToday(account.email);
      expect(already).toBe(1); // the test's own wedding
      for (let n = already + 1; n <= WEDDINGS_PER_DAY; n++) {
        const { status } = await weddingData.createWeddingRaw({ name: uniqueTitle(testInfo.workerIndex, `Cap ${n}`) });
        expect(status, `wedding ${n}`).toBe(201);
      }
      const refused = await weddingData.createWeddingRaw({ name: uniqueTitle(testInfo.workerIndex, "Cap over") });
      expect(refused.status).toBe(429);
      expect(refused.body.error).toBe("You've created a lot of weddings today — you can create more tomorrow.");
      const copy = await context.request.post(`/api/v1/weddings/${w}/duplicate`, { data: {} });
      expect(copy.status()).toBe(429);
      expect(((await copy.json()) as { error: string }).error).toBe(refused.body.error);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.seatwise-email-holds-up-against-abuse.password-resets-for-unconfirmed-and-locked-accounts",
    title: "an unconfirmed account's password reset is held to its address's daily share, a confirmed one's isn't, and a locked account's resets don't use up the day's reset limit",
    objective:
      "Confirms that a reset for an account that hasn't confirmed its address isn't sent once that address has had its 5 emails today (and the refused request counts against nothing), that once the account is confirmed a reset to the same address goes out, and that an email at its daily reset limit is refused -- until the account is locked by wrong passwords, when a reset is sent and the daily count doesn't move.",
    expectedOutcome:
      "Unconfirmed, address at 5: 200 with sent false and a 'tomorrow' message, no usable reset link, both per-email reset counts 0. Confirmed: 200 sent true. Second account at 6 resets today: 429. After locking it (sign-in refused with 429): 200 sent true, daily count still 6.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser, playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    const unconfirmed = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "reset-unconfirmed", { confirmEmail: false });
    const locked = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "reset-locked");
    const reset = (email: string) => visitor.post("/api/v1/auth/forgot-password", { data: { email } });
    try {
      await test.step("An unconfirmed account's reset isn't sent once its address has had today's emails, and counts nothing", async () => {
        await setEmailsToAddressToday(unconfirmed.email, EMAILS_PER_ADDRESS_PER_DAY);
        const res = await reset(unconfirmed.email);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { sent: boolean; message: string };
        expect(body.sent).toBe(false);
        expect(body.message).toMatch(/tomorrow/);
        expect(await usableResetTokenCount(unconfirmed.email)).toBe(0);
        expect(await passwordResetCount(unconfirmed.email, "per-email-15-minutes")).toBe(0);
        expect(await passwordResetCount(unconfirmed.email, "per-email-day")).toBe(0);
        expect(await emailsToAddressToday(unconfirmed.email)).toBe(EMAILS_PER_ADDRESS_PER_DAY);
      });

      await test.step("Once the account is confirmed, its reset goes out to the same address", async () => {
        await confirmTestAccountEmail(unconfirmed.email);
        const res = await reset(unconfirmed.email);
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
        expect(await usableResetTokenCount(unconfirmed.email)).toBe(1);
      });

      await test.step("At the daily reset limit a reset is refused -- until the account is locked by wrong passwords", async () => {
        await setPasswordResetCount(locked.email, "per-email-day", PASSWORD_RESETS_PER_EMAIL_PER_DAY);
        expect((await reset(locked.email)).status()).toBe(429);

        await setSignInFailuresForAccount(locked.email, SIGN_IN_FAILURES_PER_ACCOUNT);
        const signIn = await visitor.post("/api/v1/auth/login", { data: { email: locked.email, password: "not-the-password" } });
        expect(signIn.status()).toBe(429);
        // The refused request above was counted too, so compare with the count as it is now.
        const resetsBefore = await passwordResetCount(locked.email, "per-email-day");
        const res = await reset(locked.email);
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
        expect(await passwordResetCount(locked.email, "per-email-day")).toBe(resetsBefore);
      });
    } finally {
      await visitor.dispose();
      await unconfirmed.context.close();
      await locked.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.seatwise-email-holds-up-against-abuse.resend-link-that-sends-nothing-uses-nothing",
    title: "\"Resend link\" tries that send nothing don't use up the account's resends",
    objective:
      "Confirms that while an unconfirmed account's address has had its 5 emails today, \"Resend link\" is refused each time with a message saying so, and that those refused tries don't count: once the address has room again, a resend goes out even though more tries were made than the 3 allowed in 15 minutes.",
    expectedOutcome:
      "Four resends with the address at 5: each 429 mentioning the address has had as many emails as it can today. With the address back at 0: the next resend returns 200 sent true.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const session = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "resend-gives-back", { confirmEmail: false });
    const resend = () => session.context.request.post("/api/v1/auth/verification-email", { data: {} });
    try {
      await test.step("With the address's emails used up, each resend is refused and says why", async () => {
        await setEmailsToAddressToday(session.email, EMAILS_PER_ADDRESS_PER_DAY);
        for (let i = 1; i <= RESENDS_PER_ACCOUNT_15_MINUTES + 1; i++) {
          const res = await resend();
          expect(res.status(), `resend ${i}`).toBe(429);
          expect(((await res.json()) as { error: string }).error, `resend ${i}`).toMatch(/as many emails from Seatwise as it can today/);
        }
      });

      await test.step("Those refused tries didn't count: with room again, a resend goes out", async () => {
        await setEmailsToAddressToday(session.email, 0);
        const res = await resend();
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
      });
    } finally {
      await session.context.close();
    }
  },
);
