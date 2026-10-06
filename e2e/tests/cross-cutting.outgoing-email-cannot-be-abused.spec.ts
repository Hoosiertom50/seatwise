/**
 * TS-156 (REQ-NON-FUNCTIONAL) — Seatwise sends every email from one Gmail account, so nobody can
 * use it to spam or phish strangers. A person's or wedding's name (which goes into those emails)
 * can't look like a web address or contain line breaks; and one person can send at most 20 invites
 * an hour.
 *
 * TS-171: the RSVP-email limit is now the account's daily allowance for every kind of email (100),
 * and one guest's link isn't re-emailed within the hour -- so the old "150 RSVP emails to one guest"
 * step is covered by cross-cutting.no-one-can-use-up-seatwise-email.spec.ts instead.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";
import { SignupPage } from "../pages/SignupPage.js";
import { ageTestAccount } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "cross-cutting.outgoing-email-cannot-be-abused.names-and-send-limits",
    title:
      "names that look like web addresses are refused, and invites are capped at 20 an hour",
    objective:
      "Confirms that signup refuses a name that looks like a web address or contains a line break (and the signup page says which field and why), that a wedding name that looks like a web address is refused, and that a 21st invite within an hour is refused with 429 and not created.",
    expectedOutcome:
      "Signup and wedding-name attempts get 422 with a name field error; the page shows 'Name: Can't look like a web address'. Invites 1-20 get 201 and the 21st gets 429 with the 'sent a lot of invites' message, leaving 20 invites.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: [
      "@mutating",
      "@feature:collaboration",
      "@feature:guests",
      "@risk:high",
      "@suite:regression",
    ],
  },
  async ({ account, managedWedding, context, browser }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    // TS-194: past its first week, so the account's daily allowance (20 a day for a new account)
    // isn't what stops the 21st invite -- this test is about the hourly invite cap.
    await ageTestAccount(account.email, 8);

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
  },
);
