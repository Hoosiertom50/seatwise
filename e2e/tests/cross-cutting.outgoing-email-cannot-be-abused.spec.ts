/**
 * TS-156 (REQ-NON-FUNCTIONAL) — Seatwise sends every email from one Gmail account, so nobody can
 * use it to spam or phish strangers. A person's or wedding's name (which goes into those emails)
 * can't look like a web address or contain line breaks; one person can send at most 20 invites an
 * hour; and once they've sent 150 RSVP emails in an hour the link is still made but not emailed,
 * with the planner told why.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueToken } from "../data/ids.js";
import { SignupPage } from "../pages/SignupPage.js";

defineQualityTest(
  {
    id: "cross-cutting.outgoing-email-cannot-be-abused.names-and-send-limits",
    title:
      "names that look like web addresses are refused, invites are capped at 20 an hour, and RSVP emails stop (link still made) after 150 an hour",
    objective:
      "Confirms that signup refuses a name that looks like a web address or contains a line break (and the signup page says which field and why), that a wedding name that looks like a web address is refused, that a 21st invite within an hour is refused with 429 and not created, and that after 150 RSVP emails in an hour the RSVP link is still returned but marked emailLimited and not emailed.",
    expectedOutcome:
      "Signup and wedding-name attempts get 422 with a name field error; the page shows 'Name: Can't look like a web address'. Invites 1-20 get 201 and the 21st gets 429 with the 'sent a lot of invites' message, leaving 20 invites. RSVP-link calls 1-150 report emailed: true; the 151st reports emailed: false, emailLimited: true and still carries a URL.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: [
      "@mutating",
      "@feature:collaboration",
      "@feature:guests",
      "@risk:high",
      "@suite:regression",
    ],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;

    await test.step("A name that reads as a web address, or has a line break, is refused at signup", async () => {
      // A separate context: a successful signup signs that context in.
      const visitor = await browser.newContext();
      const request = visitor.request;
      try {
        for (const name of [
          "Verify at evil.example",
          "Tom\nClick here",
          "Visit seatwise.support",
        ]) {
          const res = await request.post("/api/v1/auth/signup", {
            data: {
              name,
              email: `pw-tester-${uniqueToken(testInfo.workerIndex)}@example.invalid`,
              password: "a-long-enough-password",
            },
          });
          expect(res.status(), name).toBe(422);
          expect(JSON.stringify(await res.json())).toContain("name");
        }
        // Initials and suffixes are still fine.
        const ok = await request.post("/api/v1/auth/signup", {
          data: {
            name: "J.R. St. Clair Jr.",
            email: `pw-tester-${uniqueToken(testInfo.workerIndex)}@example.invalid`,
            password: randomBytes(12).toString("hex"),
          },
        });
        expect(ok.status()).toBe(201);
      } finally {
        await visitor.close();
      }
    });

    await test.step("The signup page says which field was refused", async () => {
      const visitor = await browser.newContext();
      try {
        const signup = new SignupPage(await visitor.newPage());
        await signup.goto();
        await signup.signUp(
          "Verify at evil.example",
          `pw-tester-${uniqueToken(testInfo.workerIndex)}@example.invalid`,
          "a-long-enough-password",
        );
        await signup.expectError("Name: Can't look like a web address");
      } finally {
        await visitor.close();
      }
    });

    await test.step("A wedding name that reads as a web address is refused", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${w}`, {
        data: { name: "Claim your gift at evil.com" },
      });
      expect(res.status()).toBe(422);
    });

    await test.step("The 21st invite in an hour is refused and not created", async () => {
      for (let i = 1; i <= 20; i++) {
        const res = await context.request.post(
          `/api/v1/weddings/${w}/invites`,
          {
            data: {
              email: `pw-invitee-${i}-${uniqueToken(testInfo.workerIndex)}@example.invalid`,
              permissionLevel: "VIEW",
            },
          },
        );
        expect(res.status(), `invite ${i}`).toBe(201);
      }
      const over = await context.request.post(`/api/v1/weddings/${w}/invites`, {
        data: {
          email: `pw-invitee-21-${uniqueToken(testInfo.workerIndex)}@example.invalid`,
          permissionLevel: "VIEW",
        },
      });
      expect(over.status()).toBe(429);
      expect(((await over.json()) as { error: string }).error).toContain(
        "sent a lot of invites",
      );
      const { invites } = (await (
        await context.request.get(`/api/v1/weddings/${w}/invites`)
      ).json()) as { invites: unknown[] };
      expect(invites).toHaveLength(20);
    });

    await test.step("After 150 RSVP emails in an hour, the link is still made but not emailed", async () => {
      const guest = await weddingData.createGuest(w, {
        ...uniquePersonName(testInfo.workerIndex),
      });
      await context.request.patch(`/api/v1/weddings/${w}/guests/${guest.id}`, {
        data: {
          email: `pw-guest-${uniqueToken(testInfo.workerIndex)}@example.invalid`,
        },
      });
      // Adding the first email above already sent one RSVP email automatically.
      type Rsvp = {
        rsvp: { url: string; emailed: boolean; emailLimited?: boolean };
      };
      for (let sent = 2; sent <= 150; sent += 10) {
        const batch = Array.from({ length: Math.min(10, 151 - sent) }, () =>
          context.request
            .post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, {
              data: {},
            })
            .then(async (r) => (await r.json()) as Rsvp),
        );
        for (const { rsvp } of await Promise.all(batch))
          expect(rsvp.emailed).toBe(true);
      }
      const over = (await (
        await context.request.post(
          `/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`,
          { data: {} },
        )
      ).json()) as Rsvp;
      expect(over.rsvp.emailed).toBe(false);
      expect(over.rsvp.emailLimited).toBe(true);
      expect(over.rsvp.url).toMatch(/\/rsvp\/[0-9a-f]{64}$/);
    });
  },
);
