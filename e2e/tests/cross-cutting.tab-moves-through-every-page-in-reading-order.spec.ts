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
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { AccountPage } from "../pages/AccountPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { checkTabOrder, type TabOrderException } from "../support/tabOrder.js";
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

const WEDDING_TABS = ["Guests", "Seating rules", "Tables", "Seating plan", "Day-of mode", "Timeline", "Budget", "Comments", "Collaborators"];

/** Walks the page's tab order, attaches the stops to the report, and returns what to assert on. */
async function tabOrderOf(page: Page, testInfo: TestInfo, where: string): Promise<{ stopCount: number; problems: string[] }> {
  const { stops, problems } = await checkTabOrder(page, { allow: ALLOWED });
  await testInfo.attach(`tab-order: ${where}`, {
    body: stops.map((s) => `${s.index + 1}. ${s.description} @ (${Math.round(s.left)}, ${Math.round(s.top)})${s.pinned ? " [pinned]" : ""}`).join("\n"),
    contentType: "text/plain",
  });
  return { stopCount: stops.length, problems };
}

defineQualityTest(
  {
    id: "cross-cutting.tab-moves-through-every-page-in-reading-order.signed-out-pages",
    title: "on the sign-in and sign-up pages, Tab moves right along a line or down the page, at desktop and phone width",
    objective:
      "Confirms that pressing Tab from the first control of the sign-in page and of the sign-up page visits every control in reading order -- each step to the right on the same line or lower on the page -- at 1280px and at 375px.",
    expectedOutcome:
      "For /login and /signup at 1280x800 and 375x812: Tab reaches at least one control and no step goes back up the page or back to the left on the same line.",
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
          expect(problems, `sign-in @ ${label}: Tab should move right along a line or down the page`).toEqual([]);
        }

        await signupPage.goto();
        await page.waitForLoadState("networkidle");
        {
          const { stopCount, problems } = await tabOrderOf(page, testInfo, `sign-up @ ${label}`);
          expect(stopCount, `sign-up @ ${label}: Tab should reach at least one control`).toBeGreaterThan(0);
          expect(problems, `sign-up @ ${label}: Tab should move right along a line or down the page`).toEqual([]);
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
      "Confirms that with a wedding holding guests, a table, a seating plan, a timeline entry, a vendor, a comment and a pending invite, pressing Tab from the first control visits every control in reading order on the dashboard, the Account page and the Guests, Seating rules, Tables, Seating plan, Day-of mode, Timeline, Budget, Comments and Collaborators tabs -- at 1280px and at 375px.",
    expectedOutcome:
      "For each of those 11 pages at 1280x800 and 375x812: Tab reaches at least one control and no step goes back up the page or back to the left on the same line (controls in a sticky header may come first).",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:non-functional", "@accessibility", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    test.setTimeout(240_000);
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
    for (const { label, width, height } of WIDTHS) {
      await test.step(`Dashboard, Account page and every wedding tab at ${label} width (${width}px)`, async () => {
        await page.setViewportSize({ width, height });
        await dashboard.goto();
        await page.waitForLoadState("networkidle");
        {
          const { stopCount, problems } = await tabOrderOf(page, testInfo, `dashboard @ ${label}`);
          expect(stopCount, `dashboard @ ${label}: Tab should reach at least one control`).toBeGreaterThan(0);
          expect(problems, `dashboard @ ${label}: Tab should move right along a line or down the page`).toEqual([]);
        }

        await account.goto();
        await page.waitForLoadState("networkidle");
        {
          const { stopCount, problems } = await tabOrderOf(page, testInfo, `account @ ${label}`);
          expect(stopCount, `account @ ${label}: Tab should reach at least one control`).toBeGreaterThan(0);
          expect(problems, `account @ ${label}: Tab should move right along a line or down the page`).toEqual([]);
        }

        await wedding.goto(w);
        await wedding.waitForDataToSettle();
        for (const tab of WEDDING_TABS) {
          await wedding.openTab(tab);
          {
          const { stopCount, problems } = await tabOrderOf(page, testInfo, `"${tab}" tab @ ${label}`);
          expect(stopCount, `"${tab}" tab @ ${label}: Tab should reach at least one control`).toBeGreaterThan(0);
          expect(problems, `"${tab}" tab @ ${label}: Tab should move right along a line or down the page`).toEqual([]);
        }
        }
      });
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.tab-moves-through-every-page-in-reading-order.floor-plans-follow-the-room",
    title: "on the Tables and Seating plan floor plans, Tab follows where the tables sit, not the order they were made, at desktop and phone width",
    objective:
      "Confirms (TS-199) that with three tables made in the order right-top, left-top, left-bottom and one guest at each, Tab through the Tables tab's room floor plan and through the Seating plan tab's floor plan goes along the top row left to right, then down -- at 1280px and at 375px.",
    expectedOutcome:
      "Both floor plans: Tab reaches every table (Tables tab) or every seated guest (Seating plan), the first stop is the top-left one, and no step goes back up or back to the left on the same line.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:non-functional", "@feature:tables", "@accessibility", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    const guestNames: string[] = [];

    await test.step("Arrange: tables made right-top, left-top, left-bottom, with one guest at each", async () => {
      const spots = [
        { label: "Made First", x: 420, y: 40 },
        { label: "Made Second", x: 40, y: 40 },
        { label: "Made Third", x: 40, y: 320 },
      ];
      const tableIds: string[] = [];
      for (const spot of spots) {
        const table = await weddingData.createTable(w, { label: spot.label, capacity: 4 });
        await weddingData.updateTable(w, table.id, { positionX: spot.x, positionY: spot.y });
        tableIds.push(table.id);
      }
      const guestIds: string[] = [];
      for (let i = 0; i < spots.length; i++) {
        const name = uniquePersonName(testInfo.workerIndex);
        guestNames.push(`${name.firstName} ${name.lastName}`);
        guestIds.push((await weddingData.createGuest(w, name)).id);
      }
      const plan = await weddingData.generatePlanVersion(w);
      for (let i = 0; i < guestIds.length; i++) {
        expect((await weddingData.moveGuestAssignment(w, plan.id, guestIds[i], tableIds[i])).status).toBe(200);
      }
    });

    const tables = new TablesTabPage(page);
    const plan = new PlanTabPage(page);
    for (const { label, width, height } of WIDTHS) {
      await test.step(`Tables tab floor plan at ${label} width (${width}px)`, async () => {
        await page.setViewportSize({ width, height });
        await tables.goto(w);
        await tables.openTablesTab();
        await tables.openFloorPlan();
        await page.waitForLoadState("networkidle");
        const { stops, problems } = await checkTabOrder(page, { region: tables.floorPlanRegion(), allow: ALLOWED });
        await testInfo.attach(`tab-order: tables floor plan @ ${label}`, {
          body: stops.map((s) => `${s.index + 1}. ${s.description}`).join("\n"),
          contentType: "text/plain",
        });
        expect(stops.length, `tables floor plan @ ${label}: every table is reached`).toBe(3);
        expect(stops[0].description, `tables floor plan @ ${label}: the top-left table comes first`).toContain("Made Second");
        expect(problems, `tables floor plan @ ${label}: Tab should follow the room`).toEqual([]);
      });

      await test.step(`Seating plan floor plan at ${label} width (${width}px)`, async () => {
        await plan.goto(w);
        await plan.showFloorPlanView();
        await page.waitForLoadState("networkidle");
        const { stops, problems } = await checkTabOrder(page, { region: plan.floorPlanRegion(), allow: ALLOWED });
        await testInfo.attach(`tab-order: seating floor plan @ ${label}`, {
          body: stops.map((s) => `${s.index + 1}. ${s.description}`).join("\n"),
          contentType: "text/plain",
        });
        expect(stops.length, `seating floor plan @ ${label}: every seated guest is reached`).toBe(3);
        expect(stops[0].description, `seating floor plan @ ${label}: the guest at the top-left table comes first`).toContain(guestNames[1]);
        expect(problems, `seating floor plan @ ${label}: Tab should follow the room`).toEqual([]);
      });
    }
  },
);
