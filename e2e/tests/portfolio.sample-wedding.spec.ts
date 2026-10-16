/**
 * TS-272 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — the team's "Add a sample wedding" button on the
 * dashboard. Only confirmed accounts on a domain in SAMPLE_WEDDING_EMAIL_DOMAINS see it (the live
 * site's setting is Tom's work domain). The test accounts are all on example.invalid, so CI turns it
 * on for them with SAMPLE_WEDDING_EMAIL_DOMAINS=example.invalid; run without that setting, the
 * "not on the list" test runs instead. Which domains count is unit-tested in
 * apps/web/src/lib/sample-wedding-access.test.mts.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { signUpFreshAccountInNewContext, TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { sampleWeddingDomains } from "../../apps/web/src/lib/sample-wedding-access.js";

/** Whether the app under test has the button switched on for the test accounts' domain. */
const onForTestAccounts = sampleWeddingDomains(process.env).includes(TEST_ACCOUNT_EMAIL_DOMAIN.replace(/^@/, ""));

// What each tab shows from the sample (Collaborators: nobody but the presser, who owns it).
const SAMPLE_ON_EACH_TAB: Array<[tab: string, text: string | RegExp]> = [
  ["Guests", /44 invitations · 50 people invited/],
  ["Seating rules", "Rules (7)"],
  ["Tables", "Head Table"],
  ["Seating plan", /^Approved$/],
  ["Day-of mode", "Rosa Rivera"],
  ["Timeline", "Ceremony begins"],
  ["Budget", "Harvest Table Catering"],
  ["Comments", "Can we make sure Grandma Elena is close to the restrooms?"],
  ["Activity", /Final plan|imported|Approved/],
];

defineQualityTest(
  {
    id: "portfolio.sample-wedding.team-account-gets-a-full-wedding",
    title: "a team account's Add a sample wedding makes a wedding with something on every tab",
    objective:
      "Confirms (TS-272) that a confirmed account on the team's domain sees 'For the Seatwise team' on the dashboard, that Add a sample wedding opens a new wedding named \"Sample - Jamie & Morgan's Wedding\", and that every tab but Collaborators shows sample content, with nobody added on Collaborators.",
    expectedOutcome:
      "The section and button show. After pressing it: the new wedding's page opens with that name; Guests, Seating rules, Tables, Seating plan, Day-of mode, Timeline, Budget, Comments and Activity each show their sample content; Collaborators shows 'People with access (0)' (no one but the owner).",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:portfolio", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    test.skip(!onForTestAccounts, "SAMPLE_WEDDING_EMAIL_DOMAINS doesn't include the test accounts' domain");
    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    await expect(dashboard.addSampleWeddingButton()).toBeVisible();
    await dashboard.addSampleWedding();

    const wedding = new WeddingDetailPage(page);
    await expect(wedding.heading()).toHaveText("Sample - Jamie & Morgan's Wedding");
    for (const [tab, text] of SAMPLE_ON_EACH_TAB) {
      await test.step(tab, async () => {
        await wedding.openTab(tab);
        await expect.soft(wedding.inTabPanel(text)).toBeVisible();
      });
    }
    await test.step("Collaborators: nobody added", async () => {
      await wedding.openTab("Collaborators");
      await expect(wedding.inTabPanel("People with access (0)")).toBeVisible();
    });
  },
);

defineQualityTest(
  {
    id: "portfolio.sample-wedding.three-a-day",
    title: "Add a sample wedding is refused, with a message, after three in a day",
    objective:
      "Confirms (TS-272) that an account can add three sample weddings in 24 hours and that a fourth press shows a message saying so, with no wedding made.",
    expectedOutcome:
      "Three adds succeed (201). The fourth press shows 'You've added 3 sample weddings in the last 24 hours' and the account still has three weddings.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:portfolio", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    test.skip(!onForTestAccounts, "SAMPLE_WEDDING_EMAIL_DOMAINS doesn't include the test accounts' domain");
    const dashboard = new DashboardPage(page);
    for (let i = 0; i < 3; i++) expect((await page.request.post("/api/v1/sample-wedding")).status()).toBe(201);
    await dashboard.goto();
    await expect(dashboard.weddingLinks()).toHaveCount(3);
    await dashboard.addSampleWeddingButton().click();
    await expect(dashboard.sampleWeddingError()).toContainText("You've added 3 sample weddings in the last 24 hours");
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.reload();
    await expect(dashboard.weddingLinks()).toHaveCount(3);
  },
);

defineQualityTest(
  {
    id: "portfolio.sample-wedding.unconfirmed-account-gets-nothing",
    title: "an account whose email isn't confirmed doesn't see Add a sample wedding, and the server refuses it",
    objective:
      "Confirms (TS-272) that until the email is confirmed, an account on the team's domain sees no 'For the Seatwise team' section, and a request to add a sample wedding is answered 'Not found' with nothing made.",
    expectedOutcome:
      "The dashboard shows no such section; the availability check answers false; a POST answers 404; the account has no weddings.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:portfolio", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const fresh = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "unconfirmed", { confirmEmail: false });
    try {
      const page = await fresh.context.newPage();
      const dashboard = new DashboardPage(page);
      await dashboard.goto();
      expect(await (await page.request.get("/api/v1/sample-wedding")).json()).toEqual({ available: false });
      await expect(dashboard.sampleWeddingSection()).toHaveCount(0);
      expect((await page.request.post("/api/v1/sample-wedding")).status()).toBe(404);
      await page.reload();
      await expect(dashboard.weddingLinks()).toHaveCount(0);
    } finally {
      await fresh.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "portfolio.sample-wedding.not-on-the-list-gets-nothing",
    title: "an account not on the team's domain doesn't see Add a sample wedding, and the server refuses it",
    objective:
      "Confirms (TS-272) that with the test accounts' domain not in SAMPLE_WEDDING_EMAIL_DOMAINS (the live site's case for everyone but the team), a confirmed account sees no 'For the Seatwise team' section and a request to add one is answered 'Not found' with nothing made. Runs only when the app is started without the test domain in that setting.",
    expectedOutcome:
      "The dashboard shows no such section; the availability check answers false; a POST answers 404; the account has no weddings.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:portfolio", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    test.skip(onForTestAccounts, "SAMPLE_WEDDING_EMAIL_DOMAINS includes the test accounts' domain");
    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    expect(await (await page.request.get("/api/v1/sample-wedding")).json()).toEqual({ available: false });
    await expect(dashboard.sampleWeddingSection()).toHaveCount(0);
    expect((await page.request.post("/api/v1/sample-wedding")).status()).toBe(404);
    await page.reload();
    await expect(dashboard.weddingLinks()).toHaveCount(0);
  },
);
