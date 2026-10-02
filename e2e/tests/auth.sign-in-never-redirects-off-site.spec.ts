/**
 * TS-147 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — signing in from a link with a `?next=` value only ever
 * goes to a Seatwise page. A value that tries to reach another site, including one hidden with an
 * encoded tab or line break, lands on the dashboard instead; a real Seatwise path is still honoured.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";

const TRICKS = ["/%09/evil.example", "/%0a/evil.example", "/%0d%0a/evil.example", "/%5Cevil.example", "//evil.example"];

defineQualityTest(
  {
    id: "auth.sign-in-never-redirects-off-site.crafted-next-values-land-on-dashboard",
    title: "signing in from a crafted ?next= link never leaves Seatwise, while a real Seatwise path is still followed",
    objective:
      "Confirms that signing in from /login with ?next= values that try to reach another site (encoded tab, line feed, CR/LF, backslash, protocol-relative) always lands on the Seatwise dashboard, and that ?next=/account still lands on the Account page.",
    expectedOutcome:
      "Each crafted value ends on /dashboard on the app's own origin; ?next=/account ends on /account.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ loginPage, page, context, baseURL }, testInfo) => {
    const token = uniqueToken(testInfo.workerIndex);
    const email = `pw-tester-next-${token}@example.invalid`;
    const password = randomBytes(16).toString("base64url");
    const signup = await context.request.post("/api/v1/auth/signup", {
      data: { name: `Playwright Tester ${token}`, email, password },
    });
    expect(signup.status()).toBe(201);
    const origin = new URL(baseURL!).origin;

    for (const trick of TRICKS) {
      await test.step(`?next=${trick} lands on the dashboard`, async () => {
        await context.clearCookies();
        await loginPage.gotoWithEncodedNext(trick);
        await loginPage.login(email, password);
        await page.waitForURL((url) => url.pathname === "/dashboard");
        expect(new URL(page.url()).origin).toBe(origin);
      });
    }

    await test.step("?next=/account is still followed", async () => {
      await context.clearCookies();
      await loginPage.gotoWithEncodedNext("%2Faccount");
      await loginPage.login(email, password);
      await page.waitForURL((url) => url.pathname === "/account");
    });
  },
);
