/**
 * TS-37 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — the "invalid-credential handling" coverage the Jira
 * story calls for. Tagged `@readonly`: the only account involved is created ahead of time through
 * the API as this test's own precondition (Arrange, not the action under test -- the same
 * distinction guest-viewing.spec.ts's own doc comment makes), and the Act/Assert under test here
 * -- attempting a login with the wrong password -- makes no persistent change of its own.
 */

import { defineQualityTest, expect, test } from "../fixtures/index.js";
import { signUpFreshAccount } from "../support/auth.js";
import { uniqueToken } from "../data/ids.js";

const AUTH_COOKIE_NAME = "seatwise_token";

defineQualityTest(
  {
    id: "auth.invalid-login-is-rejected.wrong-password",
    title: "logging in with the wrong password is rejected and establishes no session",
    objective:
      "Confirms that submitting the login form with a real account's email but the wrong password shows an error and never signs the attempt in.",
    expectedOutcome:
      "The login page shows an inline error message, stays on /login, and no seatwise_token session cookie is set.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@readonly", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ loginPage, context, page, evidence }, testInfo) => {
    const email = await test.step("Arrange: create a real account ahead of time (not this test's own action under test)", async () => {
      const account = await signUpFreshAccount(context.request, testInfo.workerIndex);
      // The signup call above authenticates `context` as a side effect -- log it back out so this
      // test starts from a genuinely signed-out state, matching what "a login attempt" means.
      await context.request.post("/api/v1/auth/logout");
      return account.email;
    });

    await test.step("Act: submit the login form with the right email but a wrong password", async () => {
      await loginPage.goto();
      await loginPage.login(email, `wrong-${uniqueToken(testInfo.workerIndex)}`);
    });

    await test.step("Assert: an inline error is shown and the page stays on /login", async () => {
      await loginPage.expectError();
      expect(new URL(page.url()).pathname).toBe("/login");
    });

    await test.step("Assert: no session cookie was established by the failed attempt", async () => {
      const cookies = await context.cookies();
      expect(cookies.some((c) => c.name === AUTH_COOKIE_NAME)).toBe(false);
    });

    await evidence.checkpoint(
      "invalid-login-rejected",
      "The login page shows an inline error after a wrong-password attempt, and no session cookie was set.",
    );
  },
);
