/**
 * TS-193 (REQ-NON-FUNCTIONAL) — pressing Tab moves through every page in the order a person reads
 * it (Tom's request): each step goes to the right on the same line, or further down the page --
 * never back up, never back to the left. Checked at desktop width and at a 375px phone width, on
 * the sign-in and sign-up pages (signed out), and the dashboard, the Account page and every
 * wedding tab with some data in them (signed in).
 *
 * The walk and the rules live in e2e/support/tabOrder.ts (see its header for exactly what counts
 * as "same line" and what is skipped). Known, accepted exceptions go in ALLOWED below, each with
 * its reason -- there are none today.
 *
 * TS-200: each walk must also end cleanly (leave the page, or come back to its first control --
 * not give up at the stop limit or lose focus part-way), and stop on exactly the visible controls
 * there are; controls allowed to differ go in ALLOWED_COUNT, each with its reason -- none today.
 * And the forms that open in place are walked open too: a table's edit form (Tables), the
 * add-guest form's "+ More details" (Guests), and the "unsaved changes" question.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { AccountPage } from "../pages/AccountPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { checkTabOrder, type TabCountException, type TabOrderException } from "../support/tabOrder.js";
import { uniquePersonName, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import type { Page, TestInfo } from "@playwright/test";

const WIDTHS = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "phone", width: 375, height: 812 },
];

/** Accepted exceptions -- each one is a place a keyboard user is sent somewhere unexpected, so
 * every entry needs a reason Tom has agreed to. */
const ALLOWED: readonly TabOrderException[] = [];

/** TS-200: controls Tab may skip, or stops that aren't counted as controls -- each needs a reason
 * Tom has agreed to. */
const ALLOWED_COUNT: readonly TabCountException[] = [];

const WEDDING_TABS = ["Guests", "Seating rules", "Tables", "Seating plan", "Day-of mode", "Timeline", "Budget", "Comments", "Collaborators"];

/** Walks the page's tab order, attaches the stops to the report, and returns what to assert on. */
async function tabOrderOf(page: Page, testInfo: TestInfo, where: string): Promise<{ stopCount: number; problems: string[] }> {
  const { stops, problems, walk, walkProblems } = await checkTabOrder(page, { allow: ALLOWED, allowCount: ALLOWED_COUNT });
  await testInfo.attach(`tab-order: ${where}`, {
    body: [
      ...stops.map((s) => `${s.index + 1}. ${s.description} @ (${Math.round(s.left)}, ${Math.round(s.top)})${s.pinned ? " [pinned]" : ""}`),
      // TS-200: how the walk ended and how many controls there were, so a failure can be read here.
      `(walk ended: ${walk.end}; visible controls: ${walk.focusableCount})`,
    ].join("\n"),
    contentType: "text/plain",
  });
  // TS-200: a walk that can't be trusted fails the same check as a step in the wrong order.
  return { stopCount: stops.length, problems: [...walkProblems, ...problems] };
}

/** Walks the page and asserts it reached something and every step was in reading order. */
async function expectReadingOrder(page: Page, testInfo: TestInfo, where: string): Promise<void> {
  const { stopCount, problems } = await tabOrderOf(page, testInfo, where);
  expect(stopCount, `${where}: Tab should reach at least one control`).toBeGreaterThan(0);
  expect(problems, `${where}: Tab should reach every control, moving right along a line or down the page`).toEqual([]);
}

defineQualityTest(
  {
    id: "cross-cutting.tab-moves-through-every-page-in-reading-order.signed-out-pages",
    title: "on the sign-in and sign-up pages, Tab moves right along a line or down the page, at desktop and phone width",
    objective:
      "Confirms that pressing Tab from the first control of the sign-in page and of the sign-up page visits every control in reading order -- each step to the right on the same line or lower on the page -- at 1280px and at 375px.",
    expectedOutcome:
      "For /login and /signup at 1280x800 and 375x812: Tab reaches at least one control, the walk ends by leaving the page or coming back to its first control, it stops on exactly the visible controls, and no step goes back up the page or back to the left on the same line.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@readonly", "@feature:non-functional", "@accessibility", "@risk:normal", "@suite:regression"],
  },
  async ({ page, loginPage, signupPage }, testInfo) => {
    for (const { label, width, height } of WIDTHS) {
      await test.step(`Sign-in and sign-up pages at ${label} width (${width}px)`, async () => {
        await page.setViewportSize({ width, height });
        await loginPage.goto();
        await page.waitForLoadState("networkidle");
        {
          const { stopCount, problems } = await tabOrderOf(page, testInfo, `sign-in @ ${label}`);
          expect(stopCount, `sign-in @ ${label}: Tab should reach at least one control`).toBeGreaterThan(0);
          expect(problems, `sign-in @ ${label}: Tab should reach every control, moving right along a line or down the page`).toEqual([]);
        }

        await signupPage.goto();
        await page.waitForLoadState("networkidle");
        {
          const { stopCount, problems } = await tabOrderOf(page, testInfo, `sign-up @ ${label}`);
          expect(stopCount, `sign-up @ ${label}: Tab should reach at least one control`).toBeGreaterThan(0);
          expect(problems, `sign-up @ ${label}: Tab should reach every control, moving right along a line or down the page`).toEqual([]);
        }
      });
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.tab-moves-through-every-page-in-reading-order.signed-in-pages-and-every-wedding-tab",
    title: "on the dashboard, the Account page and every wedding tab with data in it, Tab moves right along a line or down the page, at desktop and phone width",
    objective:
      "Confirms that with a wedding holding guests, a table, a seating plan, a timeline entry, a vendor, a comment and a pending invite, pressing Tab from the first control visits every visible control, once, in reading order on the dashboard, the Account page and the Guests, Seating rules, Tables, Seating plan, Day-of mode, Timeline, Budget, Comments and Collaborators tabs, and with a table's edit form open, the add-guest form's More details open, and the unsaved-changes question showing -- at 1280px and at 375px.",
    expectedOutcome:
      "For each of those 11 pages and 3 open-form states at 1280x800 and 375x812: Tab reaches at least one control, the walk ends by leaving the page or coming back to its first control, it stops on exactly the visible controls, and no step goes back up the page or back to the left on the same line (controls in a sticky header may come first).",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:non-functional", "@accessibility", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    // TS-200: three more walks (forms open) at each width.
    test.setTimeout(300_000);
    const w = managedWedding.id;

    await test.step("Arrange: guests, a table, a plan, a timeline entry, a vendor, a comment and an invite", async () => {
      const first = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      await weddingData.createTable(w, { label: "Tab Order Table", capacity: 6 });
      await weddingData.generatePlanVersion(w);
      const entry = await weddingData.createTimelineEntry(w, { time: "16:30", description: "Ceremony begins" });
      expect(entry.status).toBe(201);
      const vendor = await context.request.post(`/api/v1/weddings/${w}/vendors`, {
        data: { name: "Tab Order Florist", category: "FLORIST", contactPhone: "(317) 555-0199", costCents: 150_000 },
      });
      expect(vendor.status()).toBe(201);
      const comment = await weddingData.postComment(w, { targetType: "GUEST", guestId: first.id, body: "Seat near the door?" });
      expect(comment.status).toBe(201);
      const invite = await weddingData.createInvite(w, `pw-tab-order-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`, "VIEW");
      expect(invite.status).toBe(201);
    });

    const dashboard = new DashboardPage(page);
    const account = new AccountPage(page);
    const wedding = new WeddingDetailPage(page);
    const tables = new TablesTabPage(page);
    const guests = new WeddingGuestsPage(page);
    for (const { label, width, height } of WIDTHS) {
      await test.step(`Dashboard, Account page and every wedding tab at ${label} width (${width}px)`, async () => {
        await page.setViewportSize({ width, height });
        await dashboard.goto();
        await page.waitForLoadState("networkidle");
        await expectReadingOrder(page, testInfo, `dashboard @ ${label}`);

        await account.goto();
        await page.waitForLoadState("networkidle");
        await expectReadingOrder(page, testInfo, `account @ ${label}`);

        await wedding.goto(w);
        await wedding.waitForDataToSettle();
        for (const tab of WEDDING_TABS) {
          await wedding.openTab(tab);
          await expectReadingOrder(page, testInfo, `"${tab}" tab @ ${label}`);
        }

        // TS-200: the forms that open in place, walked while open.
        await wedding.openTab("Tables");
        await tables.openTableEdit("Tab Order Table");
        await expectReadingOrder(page, testInfo, `Tables tab, edit form open @ ${label}`);
        await tables.cancelTableEdit("Tab Order Table");

        await wedding.openTab("Guests");
        await guests.openMoreDetails();
        await expect(guests.optionalFieldsVisible()).toBeVisible();
        await expectReadingOrder(page, testInfo, `Guests tab, More details open @ ${label}`);

        await guests.typeNewGuestFirstName("Half-typed");
        await wedding.clickTab("Tables");
        await expect(wedding.unsavedChangesPrompt()).toBeVisible();
        await expectReadingOrder(page, testInfo, `unsaved-changes question showing @ ${label}`);
        await wedding.leaveTabWithoutSaving();
      });
    }
  },
);
