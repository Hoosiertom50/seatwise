/**
 * TS-171 (REQ-NON-FUNCTIONAL) — Seatwise sends every email from one account with a daily limit, so
 * no one person, address or network can use it up, or use it to fill a stranger's inbox.
 * - One account can make Seatwise send at most 100 emails a day, of every kind together -- 20 a day
 *   in its first week (TS-194, Tom's decision).
 * - One email address gets at most 5 emails a day from Seatwise, however many guests or invites
 *   point at it (password resets and notifications to a wedding's own members aside) -- and one
 *   account at most 3 of them (TS-203). "A day" is now the last 24 hours, rolling (TS-203).
 * - Asking for a guest's RSVP link again doesn't re-email them within the hour; a new link does.
 * - Sign-up confirmations, "Resend link" and password resets asked for from one network address
 *   count together: 10 a day (TS-194). Sign-up itself is never refused for it -- past it, no confirmation
 *   email goes out (Resend link works later).
 * - A wedding's name can't hold a phone number (it's shown in emails to people outside it).
 * Which emails may use the password-reset headroom, and the fixed subject lines, are unit-tested
 * (email-delivery.test.mts, email-content.test.mts) -- tests here run with emails only logged.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { tagTestName, uniquePersonName, uniqueTestAddress, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import {
  ageTestAccount,
  emailsToAddressToday,
  setAccountEmailCount,
  setEmailsToAddressToday,
  useUpAccountEmailAllowance,
} from "../support/testDatabase.js";
import { waitUntilSafelyInsideUtcDay } from "../support/utcDay.js";
import { patchWedding } from "../data/api.js";

type RsvpEmail = { emailed: boolean; emailFailed: boolean; emailLimited: boolean; recipientLimited: boolean };
type RsvpLink = { url: string; emailed: boolean; emailFailed: boolean; recentlyEmailed?: boolean };

const ACCOUNT_EMAILS_PER_DAY = 100;
const NEW_ACCOUNT_EMAILS_PER_DAY = 20;
const EMAILS_PER_ADDRESS_PER_DAY = 5;
const ACCOUNT_EMAILS_PER_NETWORK_ADDRESS_PER_DAY = 10;
// TS-203: an account's allowance rolls over the last 24 hours, so the messages say that and how
// long until more can go -- never "today"/"tomorrow" (which meant midnight UTC).
const WAIT = "(in under an hour|in about \\d+ hours|in about a day|within about a day)";
const NEW_ACCOUNT_LIMIT_MESSAGE = new RegExp(
  `^New accounts can send up to 20 emails in any 24 hours during their first week, and you've reached that — you can send more ${WAIT}\\.$`,
);
const ACCOUNT_LIMIT_MESSAGE = new RegExp(`^You've reached your account's email limit for the last 24 hours — you can send more ${WAIT}\\.$`);
// TS-203: one account may use only 3 of an address's 5 planner-sent emails.
const EMAILS_PER_ADDRESS_PER_SENDER = 3;

defineQualityTest(
  {
    id: "cross-cutting.no-one-can-use-up-seatwise-email.account-daily-allowance-and-wedding-names",
    title: "a new account sends at most 20 emails a day across invites and RSVP emails (100 once it's a week old), and a wedding name can't hold a phone number",
    objective:
      "Confirms (TS-194, Tom's decision) that a fresh account's 5 invites and 15 RSVP emails (guests added with an email) all go out, that the next guest's RSVP email is held back (link still made, marked emailLimited) and the next invite is refused with 429 saying new accounts get 20 a day in their first week; that once the account is past its first week its allowance is 100 (the 100th email of the day goes out, the 101st invite is refused with the usual words); and that renaming a wedding to text with a 7+ digit phone number is refused with a message saying so.",
    expectedOutcome:
      "Invites 1–5 return 201 with emailed true; guests 1–15 report rsvpEmail.emailed true; guest 16 reports emailed false and emailLimited true; invite 6 returns 429 with the new-account message. Aged 8 days with 99 used: a guest's RSVP email goes out; the next invite returns 429 with \"You've reached your account's email limit for the last 24 hours — you can send more …\" and how long (TS-203: never today/tomorrow). Renaming to 'Call 1 800 555 0199 now' returns 422 mentioning a phone number, while 'Ana & Bo 2026' is accepted.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:collaboration", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ account, managedWedding, context }, testInfo) => {
    test.setTimeout(180_000);
    // TS-192: the daily counters this test sets and reads must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const w = managedWedding.id;
    const invite = () =>
      context.request.post(`/api/v1/weddings/${w}/invites`, {
        data: { email: `pw-invitee-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`, permissionLevel: "VIEW" },
      });
    const addGuestWithEmail = async () => {
      const res = await context.request.post(`/api/v1/weddings/${w}/guests`, {
        data: { ...uniquePersonName(testInfo.workerIndex), email: `pw-guest-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}` },
      });
      expect(res.status()).toBe(201);
      return ((await res.json()) as { rsvpEmail: RsvpEmail }).rsvpEmail;
    };

    await test.step("A new account: five invites and 15 RSVP emails all go out", async () => {
      for (let i = 1; i <= 5; i++) {
        const res = await invite();
        expect(res.status(), `invite ${i}`).toBe(201);
        expect(((await res.json()) as { emailed: boolean }).emailed, `invite ${i}`).toBe(true);
      }
      for (let added = 0; added < NEW_ACCOUNT_EMAILS_PER_DAY - 5; added += 5) {
        const batch = await Promise.all(Array.from({ length: Math.min(5, NEW_ACCOUNT_EMAILS_PER_DAY - 5 - added) }, addGuestWithEmail));
        for (const rsvpEmail of batch) expect(rsvpEmail.emailed).toBe(true);
      }
    });

    await test.step("The new account's 21st email of the day isn't sent, whatever kind it is, and it says why", async () => {
      const rsvpEmail = await addGuestWithEmail();
      expect(rsvpEmail.emailed).toBe(false);
      expect(rsvpEmail.emailLimited).toBe(true);
      const refused = await invite();
      expect(refused.status()).toBe(429);
      expect(((await refused.json()) as { error: string }).error).toMatch(NEW_ACCOUNT_LIMIT_MESSAGE);
    });

    await test.step("Past its first week the account has 100 a day: the 100th goes out, the 101st doesn't", async () => {
      await ageTestAccount(account.email, 8);
      await setAccountEmailCount(account.email, "account-day", ACCOUNT_EMAILS_PER_DAY - 1);
      expect((await addGuestWithEmail()).emailed).toBe(true);
      const refused = await invite();
      expect(refused.status()).toBe(429);
      expect(((await refused.json()) as { error: string }).error).toMatch(ACCOUNT_LIMIT_MESSAGE);
    });

    await test.step("A wedding's name can't hold a phone number", async () => {
      const refused = await patchWedding(context.request, w, { data: { name: "Call 1 800 555 0199 now" } });
      expect(refused.status()).toBe(422);
      expect(JSON.stringify(await refused.json())).toContain("phone number");
      const allowed = tagTestName(`Ana & Bo 2026 ${uniqueToken(testInfo.workerIndex)}`);
      expect((await patchWedding(context.request, w, { data: { name: allowed } })).ok()).toBe(true);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.no-one-can-use-up-seatwise-email.one-address-and-rsvp-link-resends",
    title: "one email address gets at most 5 emails in 24 hours however many guests share it (one account at most 3 of them), and asking for a guest's RSVP link again doesn't re-email them within the hour",
    objective:
      "Confirms that with 2 emails already sent to an address by others, three guests added with it are each emailed their RSVP link, that the next guest with that address isn't (link still made, marked recipientLimited) and neither is an invite to it (invite still made, accept link handed to the owner), while a guest with another address is; that (TS-203) one account's fourth guest with a fresh address isn't emailed either, leaving that address room for other planners; and that once a guest has been emailed, asking for their RSVP link again returns it without emailing (recentlyEmailed), while a new link is emailed straight away and restarts the hour.",
    expectedOutcome:
      "Shared address at 2: guests 1–3 emailed true, the address's count 5. Next guest: emailed false, recipientLimited true. Invite to that address: 201, emailed false, acceptUrl present. A guest with a different address: emailed true. Fresh address: guests 1–3 emailed true, the 4th emailed false with recipientLimited true, the address's count 3. RSVP link asked for again: emailed false, emailFailed false, recentlyEmailed true, same URL twice. New link: emailed true, different URL; asked for again afterwards: recentlyEmailed true.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, context }, testInfo) => {
    // TS-192: the daily counters this test sets and reads must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const w = managedWedding.id;
    const addGuest = async (email: string) => {
      const res = await context.request.post(`/api/v1/weddings/${w}/guests`, { data: { ...uniquePersonName(testInfo.workerIndex), email } });
      expect(res.status()).toBe(201);
      return (await res.json()) as { guest: { id: string }; rsvpEmail: RsvpEmail };
    };
    const rsvpLink = async (guestId: string, regenerate: boolean) => {
      const res = await context.request.post(`/api/v1/weddings/${w}/guests/${guestId}/rsvp-link`, { data: { regenerate } });
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { rsvp: RsvpLink }).rsvp;
    };

    await test.step("One address: five emails, then no more in 24 hours -- for RSVP links or invites; one account only three of them", async () => {
      const shared = `pw-guest-shared-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      // TS-203: two emailed to it already by other accounts, then this one's three.
      await setEmailsToAddressToday(shared, EMAILS_PER_ADDRESS_PER_DAY - EMAILS_PER_ADDRESS_PER_SENDER);
      for (let i = 1; i <= EMAILS_PER_ADDRESS_PER_SENDER; i++) {
        expect((await addGuest(shared)).rsvpEmail.emailed, `guest ${i}`).toBe(true);
      }
      expect(await emailsToAddressToday(shared)).toBe(EMAILS_PER_ADDRESS_PER_DAY);
      const sixth = (await addGuest(shared)).rsvpEmail;
      expect(sixth.emailed).toBe(false);
      expect(sixth.recipientLimited).toBe(true);

      const invite = await context.request.post(`/api/v1/weddings/${w}/invites`, { data: { email: shared, permissionLevel: "VIEW" } });
      expect(invite.status()).toBe(201);
      const body = (await invite.json()) as { emailed: boolean; acceptUrl?: string };
      expect(body.emailed).toBe(false);
      expect(body.acceptUrl).toMatch(/\/invites\/[0-9a-f]{64}$/);

      const other = await addGuest(`pw-guest-other-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`);
      expect(other.rsvpEmail.emailed).toBe(true);
    });

    await test.step("One account can't use up an address's five on its own: its fourth to a fresh address isn't sent", async () => {
      const fresh = `pw-guest-fresh-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      for (let i = 1; i <= EMAILS_PER_ADDRESS_PER_SENDER; i++) {
        expect((await addGuest(fresh)).rsvpEmail.emailed, `guest ${i}`).toBe(true);
      }
      const fourth = (await addGuest(fresh)).rsvpEmail;
      expect(fourth.emailed).toBe(false);
      expect(fourth.recipientLimited).toBe(true);
      // The address still has room for the two other planners' emails.
      expect(await emailsToAddressToday(fresh)).toBe(EMAILS_PER_ADDRESS_PER_SENDER);
    });

    await test.step("Asking for an emailed guest's link again doesn't email them again; a new link does", async () => {
      const { guest, rsvpEmail } = await addGuest(`pw-guest-resend-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`);
      expect(rsvpEmail.emailed).toBe(true);

      const again = await rsvpLink(guest.id, false);
      expect(again).toMatchObject({ emailed: false, emailFailed: false, recentlyEmailed: true });
      const onceMore = await rsvpLink(guest.id, false);
      expect(onceMore.recentlyEmailed).toBe(true);
      expect(onceMore.url).toBe(again.url);

      const fresh = await rsvpLink(guest.id, true);
      expect(fresh.emailed).toBe(true);
      expect(fresh.url).not.toBe(again.url);
      expect((await rsvpLink(guest.id, false)).recentlyEmailed).toBe(true);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.no-one-can-use-up-seatwise-email.account-emails-per-network-address",
    title: "sign-up confirmations, resent confirmation links and password resets from one network address count together, 10 a day, and sign-up itself is never refused for it",
    objective:
      "Confirms that with one network address's daily allowance of account emails nearly used up, a resend still goes out, after which a password reset from that address is refused with 429, a sign-up from it still succeeds but without its confirmation email, and the same password reset from another address is sent.",
    expectedOutcome:
      "With 1 left: the resend returns 200 sent true. Then: the reset returns 429; the sign-up returns 201 with verificationEmailSent false; the reset from another address returns 200 sent true.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ playwright }, testInfo) => {
    // TS-192: the daily counters this test sets and reads must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const baseURL = testInfo.project.use.baseURL;
    const address = uniqueTestAddress();
    const from = (a: string) => playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": a } });
    const one = await from(address);
    const other = await from(uniqueTestAddress());
    const signUp = async () => {
      const email = `pw-tester-per-address-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      const res = await one.post("/api/v1/auth/signup", {
        data: { name: `Playwright Tester ${uniqueToken(testInfo.workerIndex)}`, email, password: randomBytes(12).toString("hex") },
      });
      return { email, status: res.status(), body: (await res.json()) as { verificationEmailSent?: boolean } };
    };
    const reset = (client: typeof one, email: string) => client.post("/api/v1/auth/forgot-password", { data: { email } });

    try {
      const first = await signUp();
      expect(first.status).toBe(201);
      await test.step("With one email left, a resent confirmation link still goes out", async () => {
        await useUpAccountEmailAllowance(address, ACCOUNT_EMAILS_PER_NETWORK_ADDRESS_PER_DAY, 1);
        const res = await one.post("/api/v1/auth/verification-email", { data: {} });
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { sent: boolean }).sent).toBe(true);
      });

      await test.step("Then a reset is refused, a sign-up still works (without its email), and another address is unaffected", async () => {
        expect((await reset(one, first.email)).status()).toBe(429);
        const later = await signUp();
        expect(later.status).toBe(201);
        expect(later.body.verificationEmailSent).toBe(false);
        const elsewhere = await reset(other, first.email);
        expect(elsewhere.status()).toBe(200);
        expect(((await elsewhere.json()) as { sent: boolean }).sent).toBe(true);
      });
    } finally {
      await one.dispose();
      await other.dispose();
    }
  },
);
