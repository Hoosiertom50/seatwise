/**
 * TS-118 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — every tab of a brand-new wedding says plainly that it has
 * nothing in it yet, instead of showing a blank area. The 2026-09-30 coverage audit found none of
 * these empty states tested.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";

const EMPTY_STATES: { tab: string; message: RegExp }[] = [
  { tab: "Guests", message: /^No guests yet — add your first one above\.$/ },
  { tab: "Seating rules", message: /^No seating rules yet\.$/ },
  { tab: "Tables", message: /^No tables yet — add one above/ },
  { tab: "Seating plan", message: /^No plan generated yet/ },
  { tab: "Day-of mode", message: /^No seating plan generated yet/ },
  { tab: "Timeline", message: /^No timeline entries yet\.$/ },
  { tab: "Budget", message: /^No vendors recorded yet\.$/ },
  { tab: "Comments", message: /^No comments yet\.$/ },
  { tab: "Collaborators", message: /^No collaborators yet — invite someone above\.$/ },
];

defineQualityTest(
  {
    id: "wedding-detail.every-tab-says-when-it-has-nothing-yet.new-wedding-empty-states",
    title: "every tab of a brand-new wedding shows its own 'nothing here yet' message",
    objective:
      "Confirms that on a wedding with no guests, rules, tables, plan, timeline, vendors, comments or collaborators, each of those tabs shows its empty-state message rather than a blank area.",
    expectedOutcome:
      "Guests, Seating rules, Tables, Seating plan, Day-of mode, Timeline, Budget, Comments and Collaborators each show their 'No … yet' message.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }) => {
    const detail = new WeddingDetailPage(page);
    await page.goto(`/weddings/${managedWedding.id}`);
    for (const { tab, message } of EMPTY_STATES) {
      await test.step(`${tab}: says it has nothing yet`, async () => {
        await detail.openTab(tab);
        await expect(detail.textLocator(message)).toBeVisible();
      });
    }
  },
);
