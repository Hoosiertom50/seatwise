/**
 * TS-186 (REQ-NON-FUNCTIONAL, REQ-ACCOUNT-WEDDING-MANAGEMENT) — Seatwise's email limits hold up
 * and say the right thing.
 * - A guest's RSVP link is emailed at most once a real hour: clicks in between record nothing (so
 *   they can't push the hour back), and after "Reset all guest and vendor links" the new link can
 *   be emailed straight away.
 * - Tom's decision: a guest's changed RSVP answer is emailed to the planners at most 3 times a day
 *   (after that it only shows in the app), and those emails come out of the wedding's own pool,
 *   never the owner's daily allowance.
 * - A network address that has used up its own allowance of account emails can't go on using up
 *   someone else's password resets.
 * - Other people's wrong passwords (which can lock sign-in) don't stop someone deleting their own
 *   account, and the "too many" message doesn't say whose tries they were.
 * Counters are set directly, never waited out. TS-200: a test that sets or reads a daily counter
 * first makes sure UTC midnight won't pass while it runs (waitUntilSafelyInsideUtcDay).
 * The Retry-After arithmetic and the email budgets are unit-tested (rate-limit-retry.test.mts,
 * email-delivery.test.mts).
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { waitUntilSafelyInsideUtcDay } from "../support/utcDay.js";
import { uniquePersonName, uniqueTestAddress, uniqueToken } from "../data/ids.js";
import { signUpFreshAccountInNewContext, TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { AccountPage } from "../pages/AccountPage.js";
import {
  accountEmailCount,
  changedRsvpEmailsToday,
  moveRsvpLinkEmailTimesBack,
  passwordResetCount,
  rsvpLinkEmailTimes,
  setChangedRsvpEmailsToday,
  setSignInFailuresForAccount,
  usableResetTokenCount,
  useUpAccountEmailAllowance,
  weddingNotificationEmailsToday,
} from "../support/testDatabase.js";

type RsvpLink = { url: string; emailed: boolean; emailFailed: boolean; recentlyEmailed?: boolean };

const CHANGED_RSVP_EMAILS_PER_GUEST_PER_DAY = 3;
const ACCOUNT_EMAILS_PER_NETWORK_ADDRESS_PER_DAY = 100;
const SIGN_IN_FAILURES_PER_ACCOUNT = 100;
const RESET_REQUESTS_PER_EMAIL_15_MINUTES = 3;
const DELETE_FAILURES_PER_ACCOUNT_AND_ADDRESS = 10;

defineQualityTest(
  {
    id: "cross-cutting.email-and-limits-say-the-right-thing.rsvp-link-hour-is-real-and-reset-links-can-be-sent",
    title: "a guest's RSVP link is emailed at most once a real hour, clicks in between don't push the hour back, and a link made by resetting all links can be emailed at once",
    objective:
      "Confirms that after a guest is emailed their RSVP link, asking for it again three times returns it without emailing and records nothing more; that 55 minutes later it's still held back; that once the hour has passed (61 minutes after the email) it's emailed again; and that right after the owner resets all guest and vendor links, the guest's new link is emailed at once.",
    expectedOutcome:
      "Adding the guest: emailed true, one email time recorded. Three more asks: recentlyEmailed true, still one email time. At 55 minutes: recentlyEmailed true. At 61 minutes: emailed true, two email times. After reset-links (200): emailed true with a different URL.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, context }, testInfo) => {
    const w = managedWedding.id;
    const rsvpLink = async (guestId: string) => {
      const res = await context.request.post(`/api/v1/weddings/${w}/guests/${guestId}/rsvp-link`, { data: {} });
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { rsvp: RsvpLink }).rsvp;
    };
    const added = await context.request.post(`/api/v1/weddings/${w}/guests`, {
      data: { ...uniquePersonName(testInfo.workerIndex), email: `pw-guest-hour-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}` },
    });
    expect(added.status()).toBe(201);
    const { guest, rsvpEmail } = (await added.json()) as { guest: { id: string }; rsvpEmail: { emailed: boolean } };

    await test.step("Asking again within the hour doesn't email, and records nothing that could push the hour back", async () => {
      expect(rsvpEmail.emailed).toBe(true);
      const emailedAt = await rsvpLinkEmailTimes(guest.id);
      expect(emailedAt).toHaveLength(1);
      for (let i = 1; i <= 3; i++) {
        expect(await rsvpLink(guest.id), `ask ${i}`).toMatchObject({ emailed: false, emailFailed: false, recentlyEmailed: true });
      }
      expect(await rsvpLinkEmailTimes(guest.id)).toEqual(emailedAt);
    });

    await test.step("55 minutes on it's still held back; once the hour is over it's emailed again", async () => {
      await moveRsvpLinkEmailTimesBack(guest.id, 55);
      expect((await rsvpLink(guest.id)).recentlyEmailed).toBe(true);
      await moveRsvpLinkEmailTimesBack(guest.id, 6);
      const again = await rsvpLink(guest.id);
      expect(again.emailed).toBe(true);
      expect(await rsvpLinkEmailTimes(guest.id)).toHaveLength(2);
    });

    await test.step("Right after the owner resets all links, the guest's new link is emailed at once", async () => {
      const before = await rsvpLink(guest.id);
      expect(before.recentlyEmailed).toBe(true);
      expect((await context.request.post(`/api/v1/weddings/${w}/reset-links`)).status()).toBe(200);
      const fresh = await rsvpLink(guest.id);
      expect(fresh.emailed).toBe(true);
      expect(fresh.url).not.toBe(before.url);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.email-and-limits-say-the-right-thing.changed-rsvp-answers-emailed-three-times-a-day",
    title: "a guest's changed RSVP answer is emailed at most 3 times a day, from the wedding's own pool -- never the owner's allowance",
    objective:
      "Confirms Tom's decision: with 2 of a guest's changed answers already emailed today, their next changed answer is emailed (the 3rd) and counted in the wedding's own daily pool while the owner's daily email allowance doesn't move; and that their 4th changed answer that day still shows in the app but isn't emailed.",
    expectedOutcome:
      "3rd change (Pending to Confirmed): 200, one RSVP_RECEIVED notification for the guest, changed-answer emails today 3, the wedding's pool 1, the owner's allowance unchanged. 4th change (to Declined): 200, two notifications for the guest, changed-answer emails still 3, the wedding's pool still 1, the owner's allowance unchanged.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ account, managedWedding, weddingData, context, playwright }, testInfo) => {
    // TS-200: this test sets a guest's changed-answer count for today and reads the daily
    // counters -- they must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const baseURL = testInfo.project.use.baseURL;
    const w = managedWedding.id;
    const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: {} });
    const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
    const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    const answer = async (rsvpStatus: "CONFIRMED" | "DECLINED") => {
      expect((await visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus, headcount: 1 } })).status()).toBe(200);
    };
    const notificationsForGuest = async () => {
      const { notifications } = (await (await context.request.get("/api/v1/notifications")).json()) as {
        notifications: { type: string; message: string }[];
      };
      return notifications.filter((n) => n.type === "RSVP_RECEIVED" && n.message.includes(guest.lastName)).length;
    };
    const ownersAllowance = await accountEmailCount(account.email, "account-day");
    try {
      await test.step("The 3rd changed answer of the day is emailed, from the wedding's pool", async () => {
        await setChangedRsvpEmailsToday(guest.id, CHANGED_RSVP_EMAILS_PER_GUEST_PER_DAY - 1);
        await answer("CONFIRMED");
        expect(await notificationsForGuest()).toBe(1);
        expect(await changedRsvpEmailsToday(guest.id)).toBe(CHANGED_RSVP_EMAILS_PER_GUEST_PER_DAY);
        expect(await weddingNotificationEmailsToday(w)).toBe(1);
        expect(await accountEmailCount(account.email, "account-day")).toBe(ownersAllowance);
      });

      await test.step("The 4th shows in the app but isn't emailed", async () => {
        await answer("DECLINED");
        expect(await notificationsForGuest()).toBe(2);
        expect(await changedRsvpEmailsToday(guest.id)).toBe(CHANGED_RSVP_EMAILS_PER_GUEST_PER_DAY);
        expect(await weddingNotificationEmailsToday(w)).toBe(1);
        expect(await accountEmailCount(account.email, "account-day")).toBe(ownersAllowance);
      });
    } finally {
      await visitor.dispose();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.email-and-limits-say-the-right-thing.used-up-address-cannot-use-up-someone-elses-resets",
    title: "a network address that has used up its own account emails can't use up someone else's password resets",
    objective:
      "Confirms that from a network address whose daily allowance of account emails is used up, asking for another account's password reset is refused every time -- more often than the 3 resets one email may have in 15 minutes -- without counting anything against that email or making a link; and that the account's owner, from another address, then gets their reset.",
    expectedOutcome:
      "Four requests from the used-up address: each 429; both per-email reset counts stay 0 and no usable reset link exists. From another address: 200 with sent true, and one usable link.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser, playwright }, testInfo) => {
    // TS-200: this test uses up an address's daily allowance and reads the per-day reset count --
    // they must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const baseURL = testInfo.project.use.baseURL;
    const usedUp = uniqueTestAddress();
    const fromUsedUp = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": usedUp } });
    const fromOwner = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    const owner = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "reset-owner");
    const reset = (client: typeof fromUsedUp) => client.post("/api/v1/auth/forgot-password", { data: { email: owner.email } });
    try {
      await test.step("From the used-up address, every request is refused and nothing counts against the owner's email", async () => {
        await useUpAccountEmailAllowance(usedUp, ACCOUNT_EMAILS_PER_NETWORK_ADDRESS_PER_DAY, 0);
        for (let i = 1; i <= RESET_REQUESTS_PER_EMAIL_15_MINUTES + 1; i++) {
          expect((await reset(fromUsedUp)).status(), `request ${i}`).toBe(429);
        }
        expect(await passwordResetCount(owner.email, "per-email-15-minutes")).toBe(0);
        expect(await passwordResetCount(owner.email, "per-email-day")).toBe(0);
        expect(await usableResetTokenCount(owner.email)).toBe(0);
      });

      await test.step("The owner, from their own address, still gets their reset", async () => {
        const res = await reset(fromOwner);
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
        expect(await usableResetTokenCount(owner.email)).toBe(1);
      });
    } finally {
      await fromUsedUp.dispose();
      await fromOwner.dispose();
      await owner.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.email-and-limits-say-the-right-thing.others-wrong-passwords-dont-block-deleting-your-account",
    title: "other people's wrong passwords don't stop someone deleting their own account, and too many wrong tries are refused with neutral words",
    objective:
      "Confirms that with an account locked from signing in everywhere (100 wrong passwords from elsewhere), its signed-in owner can still delete it from the Account page with their password; and that on another account, 10 wrong passwords on deletion are refused one by one and the 11th is refused with 429 and a message that doesn't say whose tries they were.",
    expectedOutcome:
      "Locked account: sign-in from another address returns 429; deleting from the Account page shows 'Your account has been deleted'. Second account: tries 1–10 return 403, the 11th 429 with 'There have been too many tries with a wrong password. Please wait N minute(s) and try again.'",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:high", "@suite:regression"],
  },
  async ({ browser, playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const signUp = async (label: string) => {
      const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
      const token = uniqueToken(testInfo.workerIndex);
      const email = `pw-tester-${label}-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      const password = randomBytes(16).toString("base64url");
      const res = await context.request.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password } });
      expect(res.status()).toBe(201);
      return { context, email, password };
    };
    const locked = await signUp("delete-locked");
    const other = await signUp("delete-wrong");
    const elsewhere = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    try {
      await test.step("An account locked by wrong passwords from elsewhere can still be deleted by its owner", async () => {
        await setSignInFailuresForAccount(locked.email, SIGN_IN_FAILURES_PER_ACCOUNT);
        const signIn = await elsewhere.post("/api/v1/auth/login", { data: { email: locked.email, password: locked.password } });
        expect(signIn.status()).toBe(429);
        const account = new AccountPage(await locked.context.newPage());
        await account.goto();
        await account.deleteAccount(locked.password);
        await expect(account.deletedHeading()).toBeVisible();
      });

      await test.step("Too many wrong passwords on deletion are refused, without saying whose they were", async () => {
        for (let i = 1; i <= DELETE_FAILURES_PER_ACCOUNT_AND_ADDRESS; i++) {
          expect((await other.context.request.delete("/api/v1/auth/me", { data: { password: `wrong-${i}` } })).status(), `try ${i}`).toBe(403);
        }
        const refused = await other.context.request.delete("/api/v1/auth/me", { data: { password: "wrong-again" } });
        expect(refused.status()).toBe(429);
        expect(((await refused.json()) as { error: string }).error).toMatch(
          /^There have been too many tries with a wrong password\. Please wait \d+ minutes? and try again\.$/,
        );
      });
    } finally {
      await elsewhere.dispose();
      await locked.context.close();
      await other.context.close();
    }
  },
);
