/**
 * TS-163 (REQ-NON-FUNCTIONAL) — Seatwise's one Gmail account can't be flooded into suspension.
 * - New accounts from one network address are limited (each account comes with its own email
 *   allowance, so unlimited sign-ups would get round it).
 * - A guest's RSVP link submitted over and over emails the planners at most once an hour, while
 *   every response still shows in the app.
 * - Invite-link lookups are limited per address, like the RSVP and vendor links.
 * - A guest's name (it goes into their RSVP email) can't read as a web address.
 * The daily ceiling on all outgoing email is covered by unit tests (email-delivery.test.mts).
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueToken } from "../data/ids.js";
import { rsvpNotificationEmailRequests } from "../support/testDatabase.js";

const SIGNUPS_PER_ADDRESS_PER_HOUR = 30;
const INVITE_LOOKUPS_PER_ADDRESS = 100;

defineQualityTest(
  {
    id: "cross-cutting.email-cannot-be-flooded-through-seatwise.signups-rsvp-emails-invite-lookups-guest-names",
    title: "sign-ups and invite-link lookups are limited per address, repeated RSVPs email planners once an hour, and guest names can't be web addresses",
    objective:
      "Confirms that 30 sign-ups from one address succeed and the 31st is refused with 429 while another address can still sign up; that four identical RSVP submits on one link create four in-app notifications while the three repeats count against the once-an-hour email rule (TS-169: a changed answer is always emailed); that the 101st invite-link lookup from one address is refused while another address is unaffected; and that a guest whose first name reads as a web address is refused.",
    expectedOutcome:
      "Sign-ups 1–30 return 201, the 31st 429; a fresh address gets 201. Four RSVP_RECEIVED notifications for the guest and three repeats counted against the once-an-hour key (one of them emailed). Lookups 1–100 return 200, the 101st 429, another address 200. Creating guest 'Claim at evilsite.com' returns 422 (refused as invalid).",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, playwright }, testInfo) => {
    test.setTimeout(120_000);
    const baseURL = testInfo.project.use.baseURL;
    const from = (address: string) => playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": address } });
    const signUp = (client: Awaited<ReturnType<typeof from>>) => {
      const token = uniqueToken(testInfo.workerIndex);
      return client.post("/api/v1/auth/signup", {
        data: { name: "Playwright Tester Flood", email: `pw-tester-flood-${token}@example.invalid`, password: randomBytes(12).toString("hex") },
      });
    };

    await test.step("Repeated RSVPs on one link: every response shows in the app, planners are emailed once", async () => {
      const w = managedWedding.id;
      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: {} });
      const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
      const visitor = await from(uniqueTestAddress());
      try {
        // TS-169: a changed answer is always emailed; the once-an-hour rule holds back repeats.
        for (const rsvpStatus of ["CONFIRMED", "CONFIRMED", "CONFIRMED", "CONFIRMED"]) {
          expect((await visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus, headcount: 1 } })).status()).toBe(200);
        }
      } finally {
        await visitor.dispose();
      }
      const { notifications } = (await (await context.request.get("/api/v1/notifications")).json()) as {
        notifications: { type: string; message: string }[];
      };
      expect(notifications.filter((n) => n.type === "RSVP_RECEIVED" && n.message.includes(guest.lastName))).toHaveLength(4);
      // The first answer is a change (from Pending) and always emailed; the three repeats count against
      // the once-an-hour key, which allows one -- so two were held back.
      expect(await rsvpNotificationEmailRequests(guest.id)).toBe(3);
    });

    await test.step("Invite-link lookups: 100 per address, then 429; another address is unaffected", async () => {
      const limited = await from(uniqueTestAddress());
      const other = await from(uniqueTestAddress());
      const lookup = (client: Awaited<ReturnType<typeof from>>) => client.get(`/api/v1/invites/${randomBytes(32).toString("hex")}`);
      try {
        for (let i = 1; i <= INVITE_LOOKUPS_PER_ADDRESS; i++) {
          expect((await lookup(limited)).status(), `lookup ${i}`).toBe(200);
        }
        expect((await lookup(limited)).status()).toBe(429);
        expect((await lookup(other)).status()).toBe(200);
      } finally {
        await limited.dispose();
        await other.dispose();
      }
    });

    await test.step("A guest's name can't read as a web address", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/guests`, {
        data: { firstName: "Claim at evilsite.com", lastName: "Prize" },
      });
      expect(res.status()).toBe(422);
    });

    // Last: the 31 sign-ups keep this test's own connection idle long enough for the server to close
    // it, which would break a request made on it straight afterwards.
    await test.step("Sign-ups: 30 an hour from one address, then 429; another address is unaffected", async () => {
      const limited = await from(uniqueTestAddress());
      const other = await from(uniqueTestAddress());
      try {
        for (let i = 1; i <= SIGNUPS_PER_ADDRESS_PER_HOUR; i++) {
          expect((await signUp(limited)).status(), `sign-up ${i}`).toBe(201);
        }
        const refused = await signUp(limited);
        expect(refused.status()).toBe(429);
        expect(refused.headers()["retry-after"]).toBeTruthy();
        expect((await signUp(other)).status()).toBe(201);
      } finally {
        await limited.dispose();
        await other.dispose();
      }
    });
  },
);
