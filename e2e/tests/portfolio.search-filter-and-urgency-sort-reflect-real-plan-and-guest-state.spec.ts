/**
 * TS-49 (REQ-PLANNER-PORTFOLIO) — no manual test case or numbered acceptance criterion exists for
 * this requirement (confirmed: `quality/acceptance-test-plan/Seatwise-Test-Cases-Final.xlsx`
 * predates TS-16's planner-pivot roadmap); authored directly from `quality/requirements.yaml`'s
 * REQ-PLANNER-PORTFOLIO description plus the actual implementation, per the ticket's own
 * instruction. Basic multi-wedding creation/listing and cross-wedding data isolation are already
 * automated under REQ-ACCOUNT-WEDDING-MANAGEMENT (TS-37's
 * `account-management.multiple-weddings-are-independent.spec.ts` / `...wedding-data-isolation...`)
 * and are not re-tested here; this test targets what's actually distinct to the portfolio/FR-11.x
 * feature set: the dashboard's own search box, plan-status filter, and sort dropdown (confirmed
 * directly in apps/web/src/app/dashboard/page.tsx to operate entirely client-side over the
 * already-fetched `GET /api/v1/weddings` list, never server-side query params), the per-row
 * plan-status badge and unassigned/needs-reassignment issue pills reflecting real plan-version
 * state, and FR-11.3's "needs attention soonest" default sort -- a bucketed comparator (future/
 * today event date, soonest first; then no date but outstanding issues; then no date and no
 * issues; then a past event date last, regardless of issues), not a plain single-column sort.
 *
 * Template-seeded creation (TS-19/FR-14.4), though surfaced on this same page, belongs to its own
 * requirement (REQ-REUSABLE-TEMPLATES, not yet automated under any ticket as of this writing) and
 * is deliberately out of scope here.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { tagTestName, uniqueToken } from "../data/ids.js";

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

defineQualityTest(
  {
    id: "portfolio.search-filter-and-urgency-sort-reflect-real-plan-and-guest-state.dashboard-controls-match-real-data",
    title: "the dashboard's search box, plan-status filter, and sort dropdown all operate correctly over real plan/guest state, and the default 'needs attention soonest' sort follows its own documented bucket order rather than a plain column sort",
    objective:
      "Confirms searching by name or venue narrows the list correctly (with a 'Showing N of M' summary and a distinct empty-match message), the plan-status filter isolates each of No-plan/Draft/In-Review/Approved, each of the five sort options produces its own fully-determined order, and every row's plan-status badge and issue pill reflect the wedding's actual current plan-version state.",
    expectedOutcome:
      "Search and filter each narrow the four-wedding list to exactly the expected subset. Sorting by urgency (default), name, event date, guest count, and outstanding issues each produce their own distinct, fully-correct order across all four weddings.",
    requirementIds: ["REQ-PLANNER-PORTFOLIO"],
    tags: ["@mutating", "@feature:portfolio", "@risk:normal", "@suite:regression"],
  },
  async ({ context, weddingData, page }, testInfo) => {
    const token = uniqueToken(testInfo.workerIndex);
    const nameAlpha = tagTestName(`Alpha ${token}`);
    const nameBeta = tagTestName(`Beta ${token}`);
    const nameGamma = tagTestName(`Gamma ${token}`);
    const nameDelta = tagTestName(`Delta ${token}`);

    await test.step("Arrange: Alpha -- no guests, no plan generated (No plan yet, no date, no issues)", async () => {
      const res = await context.request.post("/api/v1/weddings", { data: { name: nameAlpha } });
      expect(res.status()).toBe(201);
    });

    await test.step("Arrange: Beta -- a complete Draft plan, one guest, a future event date", async () => {
      const res = await context.request.post("/api/v1/weddings", {
        data: { name: nameBeta, eventDate: isoDateOffset(10), venueName: "Grand Hall" },
      });
      const wedding = ((await res.json()) as { wedding: { id: string } }).wedding;
      await weddingData.createGuest(wedding.id, { firstName: "Bea", lastName: "Beta" });
      await weddingData.createTable(wedding.id, { label: "Table 1", capacity: 1 });
      const generated = await weddingData.generatePlanVersion(wedding.id);
      expect(generated.isComplete).toBe(true);
      expect(generated.status).toBe("DRAFT");
    });

    await test.step("Arrange: Gamma -- In Review, one guest, a past event date", async () => {
      const res = await context.request.post("/api/v1/weddings", {
        data: { name: nameGamma, eventDate: isoDateOffset(-10), venueName: "Old Barn" },
      });
      const wedding = ((await res.json()) as { wedding: { id: string } }).wedding;
      await weddingData.createGuest(wedding.id, { firstName: "Gia", lastName: "Gamma" });
      await weddingData.createTable(wedding.id, { label: "Table 1", capacity: 1 });
      const generated = await weddingData.generatePlanVersion(wedding.id);
      const toReview = await weddingData.setPlanVersionStatus(wedding.id, generated.id, "IN_REVIEW");
      expect(toReview.status).toBe(200);
    });

    await test.step("Arrange: Delta -- Approved, two guests, no event date, then one guest unassigned afterward (a real outstanding issue on an Approved plan)", async () => {
      const res = await context.request.post("/api/v1/weddings", {
        data: { name: nameDelta, venueName: "New Hall" },
      });
      const wedding = ((await res.json()) as { wedding: { id: string } }).wedding;
      const guestA = await weddingData.createGuest(wedding.id, { firstName: "Dee", lastName: "Delta" });
      await weddingData.createGuest(wedding.id, { firstName: "Dan", lastName: "Delta" });
      await weddingData.createTable(wedding.id, { label: "Table 1", capacity: 1 });
      await weddingData.createTable(wedding.id, { label: "Table 2", capacity: 1 });
      const generated = await weddingData.generatePlanVersion(wedding.id);
      expect(generated.isComplete).toBe(true);
      const approved = await weddingData.setPlanVersionStatus(wedding.id, generated.id, "APPROVED");
      expect(approved.status).toBe(200);
      // Unassigning a guest AFTER approval leaves the plan APPROVED but incomplete -- confirmed
      // directly in plan-versions.ts that completeness is only checked at the moment of
      // transitioning TO Approved, never re-enforced afterward -- exactly the real-world "Approved
      // plan with a since-arisen issue" state FR-11.2's issue pill exists to surface.
      const unassign = await weddingData.moveGuestAssignment(wedding.id, generated.id, guestA.id, null);
      expect(unassign.status).toBe(200);
    });

    const dashboardPage = new DashboardPage(page);

    /** Maps each visible row's own (badge-and-count-laden) text to whichever of the four unique
     * wedding names it contains, in the exact order the app rendered them -- resolving the same
     * "everything is one blob of link text" constraint DashboardPage.weddingLink's own doc-comment
     * already documents, rather than inventing a new attribute on the app for this test alone. */
    async function visibleOrder(): Promise<string[]> {
      const texts = await dashboardPage.weddingLinks().allTextContents();
      return texts.map((text) => {
        if (text.includes(nameAlpha)) return "Alpha";
        if (text.includes(nameBeta)) return "Beta";
        if (text.includes(nameGamma)) return "Gamma";
        if (text.includes(nameDelta)) return "Delta";
        throw new Error(`Row text matched none of the four test weddings: ${text}`);
      });
    }

    await test.step("Arrange: open the dashboard with all four weddings visible", async () => {
      await dashboardPage.goto();
      await expect(dashboardPage.weddingLink(nameAlpha)).toBeVisible();
      await expect(dashboardPage.weddingLink(nameBeta)).toBeVisible();
      await expect(dashboardPage.weddingLink(nameGamma)).toBeVisible();
      await expect(dashboardPage.weddingLink(nameDelta)).toBeVisible();
    });

    await test.step("Assert: each row's plan-status badge, guest count, and issue pill reflect real state", async () => {
      const alphaRow = await dashboardPage.weddingLink(nameAlpha).textContent();
      expect(alphaRow).toContain("No plan yet");
      expect(alphaRow).toContain("0 guests");

      const betaRow = await dashboardPage.weddingLink(nameBeta).textContent();
      expect(betaRow).toContain("Draft");
      expect(betaRow).toContain("Grand Hall");
      expect(betaRow).toContain("1 guest");
      expect(betaRow).not.toContain("unassigned"); // complete plan -- the issue pill isn't rendered at all

      const gammaRow = await dashboardPage.weddingLink(nameGamma).textContent();
      expect(gammaRow).toContain("In Review");
      expect(gammaRow).toContain("Old Barn");

      const deltaRow = await dashboardPage.weddingLink(nameDelta).textContent();
      expect(deltaRow).toContain("Approved");
      expect(deltaRow).toContain("1 unassigned");
      expect(deltaRow).toContain("2 guests");
    });

    await test.step("Act + Assert: searching by venue name narrows to the one matching wedding, with the 'Showing N of M' summary", async () => {
      await dashboardPage.search("Grand Hall");
      await expect(dashboardPage.weddingLink(nameBeta)).toBeVisible();
      await expect(dashboardPage.weddingLink(nameAlpha)).not.toBeVisible();
      await expect(dashboardPage.resultsSummary()).toHaveText("Showing 1 of 4 weddings.");

      await dashboardPage.search("no wedding anywhere matches this term");
      await expect(dashboardPage.noMatchesMessage()).toBeVisible();

      await dashboardPage.search(""); // clear back to all four
    });

    await test.step("Act + Assert: the plan-status filter isolates each of No plan yet / Draft / In Review / Approved", async () => {
      await dashboardPage.filterByPlanStatus("NONE");
      expect(await visibleOrder()).toEqual(["Alpha"]);

      await dashboardPage.filterByPlanStatus("DRAFT");
      expect(await visibleOrder()).toEqual(["Beta"]);

      await dashboardPage.filterByPlanStatus("IN_REVIEW");
      expect(await visibleOrder()).toEqual(["Gamma"]);

      await dashboardPage.filterByPlanStatus("APPROVED");
      expect(await visibleOrder()).toEqual(["Delta"]);

      await dashboardPage.filterByPlanStatus("ALL");
      expect(await visibleOrder()).toHaveLength(4);
    });

    await test.step("Assert: the default sort (urgency) follows FR-11.3's own bucket order -- Beta (future date) first, then Delta (no date, has an issue), then Alpha (no date, no issues), then Gamma (past date) last regardless of its own lack of issues", async () => {
      expect(await visibleOrder()).toEqual(["Beta", "Delta", "Alpha", "Gamma"]);
    });

    await test.step("Act + Assert: sorting by name is a plain A-Z sort, independent of urgency", async () => {
      await dashboardPage.sortBy("name");
      expect(await visibleOrder()).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
    });

    await test.step("Act + Assert: sorting by event date is a plain ascending date sort (a past date sorts first, not last) with no-date weddings last, alphabetically", async () => {
      await dashboardPage.sortBy("eventDate");
      expect(await visibleOrder()).toEqual(["Gamma", "Beta", "Alpha", "Delta"]);
    });

    await test.step("Act + Assert: sorting by guest count is most-first, ties broken alphabetically", async () => {
      await dashboardPage.sortBy("guestCount");
      expect(await visibleOrder()).toEqual(["Delta", "Beta", "Gamma", "Alpha"]);
    });

    await test.step("Act + Assert: sorting by outstanding issues is most-first, ties broken alphabetically", async () => {
      await dashboardPage.sortBy("issues");
      expect(await visibleOrder()).toEqual(["Delta", "Alpha", "Beta", "Gamma"]);
    });

    await test.step("Act + Assert: switching back to urgency restores its own bucket order", async () => {
      await dashboardPage.sortBy("urgency");
      expect(await visibleOrder()).toEqual(["Beta", "Delta", "Alpha", "Gamma"]);
    });
  },
);
