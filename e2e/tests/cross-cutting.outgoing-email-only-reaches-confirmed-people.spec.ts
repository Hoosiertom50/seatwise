/**
 * TS-168 (REQ-NON-FUNCTIONAL) — the remaining ways to make Seatwise send unwanted email are closed.
 * - Notification emails only go to people who've confirmed their address (TS-164). An account
 *   signed up with a stranger's address used to get an email for every guest's RSVP.
 * - A copied wedding's name follows the wedding-name rules (it used to be length-checked only), and
 *   its default name " - copy" passes them.
 * - A CSV import refuses guest names that read as a web address, like adding a guest by hand.
 * - An invite that isn't made (the person already has access) doesn't use up the sender's invite
 *   allowance.
 * Daily caps on "Resend link" and "Forgot password" are configuration only (lib/rate-limit.ts);
 * the email-text rules are unit-tested (email-content.test.mts).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueTitle } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { weddingNotificationEmailsThisHour } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "cross-cutting.outgoing-email-only-reaches-confirmed-people.notifications-copies-imports-invites",
    title: "notification emails reach only confirmed addresses, copied weddings and imported guests follow the name rules, and failed invites don't use up the allowance",
    objective:
      "Confirms that guests' RSVPs on a wedding whose owner hasn't confirmed their email create in-app notifications but no notification emails, while the same on a confirmed owner's wedding does email; that duplicating a wedding with a web-address name is refused and the default copy is named '<name> - copy'; that a CSV row whose first name reads as a web address is an error in the preview; and that 25 refused invites (already a collaborator) still leave room for a real invite.",
    expectedOutcome:
      "Unconfirmed owner: 2 RSVP_RECEIVED notifications, 0 notification emails counted. Confirmed owner: 1 counted. Duplicate with 'Sign in at evil.com' is 422; the default copy is '<name> - copy'. The import preview row is an error mentioning a web address. After 25 refused invites (409), a new invite returns 201.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:rsvp", "@feature:collaboration", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser, playwright }, testInfo) => {
    test.setTimeout(90_000);
    const baseURL = testInfo.project.use.baseURL;
    const respondTo = async (request: typeof context.request, w: string) => {
      const guest = (await (await request.post(`/api/v1/weddings/${w}/guests`, { data: uniquePersonName(testInfo.workerIndex) })).json()) as {
        guest: { id: string };
      };
      const link = await request.post(`/api/v1/weddings/${w}/guests/${guest.guest.id}/rsvp-link`, { data: {} });
      const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
      const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
      try {
        expect((await visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "CONFIRMED", headcount: 1 } })).status()).toBe(200);
      } finally {
        await visitor.dispose();
      }
    };

    await test.step("Guests' RSVPs don't email an owner who hasn't confirmed their address", async () => {
      const stranger = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "unconfirmed", { confirmEmail: false });
      try {
        const req = stranger.context.request;
        const w = ((await (await req.post("/api/v1/weddings", { data: { name: uniqueTitle(testInfo.workerIndex, "Unconfirmed Owner") } })).json()) as {
          wedding: { id: string };
        }).wedding.id;
        await respondTo(req, w);
        await respondTo(req, w);
        const { notifications } = (await (await req.get("/api/v1/notifications")).json()) as { notifications: { type: string }[] };
        expect(notifications.filter((n) => n.type === "RSVP_RECEIVED")).toHaveLength(2);
        expect(await weddingNotificationEmailsThisHour(w)).toBe(0);
      } finally {
        await stranger.context.close();
      }
    });

    await test.step("The same on a confirmed owner's wedding does email", async () => {
      await respondTo(context.request, managedWedding.id);
      expect(await weddingNotificationEmailsThisHour(managedWedding.id)).toBe(1);
    });

    await test.step("A copied wedding's name follows the rules, and the default name passes them", async () => {
      const api = `/api/v1/weddings/${managedWedding.id}/duplicate`;
      expect((await context.request.post(api, { data: { name: "Sign in at evil.com" } })).status()).toBe(422);
      const res = await context.request.post(api, { data: {} });
      expect(res.status()).toBe(201);
      const { wedding } = (await res.json()) as { wedding: { id: string; name: string } };
      const copy = await weddingData.getWedding(wedding.id);
      expect(copy.name).toBe(`${managedWedding.name} - copy`);
    });

    await test.step("A CSV row whose name reads as a web address is refused", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/guests/import/preview`, {
        data: { csv: "firstName,lastName\nevilsite.com,Prize\n", mapping: { firstName: "firstName", lastName: "lastName" } },
      });
      expect(res.ok()).toBe(true);
      const { preview } = (await res.json()) as { preview: { rows: { kind: string; reason?: string }[] } };
      expect(preview.rows[0].kind).toBe("error");
      expect(preview.rows[0].reason).toContain("web address");
    });

    await test.step("Invites that aren't made don't use up the invite allowance", async () => {
      const member = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "member");
      try {
        await weddingData.addCollaborator(managedWedding.id, member.email, "VIEW");
        for (let i = 1; i <= 25; i++) {
          expect((await weddingData.createInvite(managedWedding.id, member.email, "EDIT")).status, `refused invite ${i}`).toBe(409);
        }
        const real = await weddingData.createInvite(managedWedding.id, `pw-invitee-${Date.now()}@example.invalid`, "VIEW");
        expect(real.status).toBe(201);
      } finally {
        await member.context.close();
      }
    });
  },
);
