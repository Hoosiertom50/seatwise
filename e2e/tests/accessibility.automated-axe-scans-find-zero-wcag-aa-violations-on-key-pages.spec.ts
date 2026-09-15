/**
 * TS-53 (REQ-NON-FUNCTIONAL) — converts AC-079 ("The app conforms to WCAG 2.1 Level AA") into
 * automated coverage. Scope confirmed with Tom on this story (see its own Jira comment history):
 * automated axe-core scans on the app's key pages, plus (in the companion file
 * `accessibility.keyboard-only-operation-and-responsive-layout-on-key-pages.spec.ts`) basic
 * keyboard-navigation and responsiveness checks. Performance (AC-072/073), usability-via-
 * automation (AC-074/075), and offline/print availability (AC-078) are explicitly out of scope.
 *
 * "Key pages" here is every one of the app's routed views: `/login`, `/signup`, `/dashboard`, and
 * all 10 tabs of the wedding-detail page (`/weddings/:id`'s own `TABS` array in
 * `apps/web/src/app/weddings/[weddingId]/page.tsx`) -- an update to README.md's own prior manual
 * exercise (NFR-9.5, "every page and wedding tab ... scanned with axe-core"), whose 11-view list
 * predates the Timeline and Budget tabs (TS-18/TS-20) and so is two views short of the app's
 * current surface. Also included: the guest's own unauthenticated RSVP page at `/rsvp/:token`
 * (`GuestRsvpPage`) -- a real, frequently-visited view that isn't part of the planner-facing
 * `/weddings/:id` shell at all, and so wouldn't be covered by the wedding-tabs scan no matter how
 * exhaustive.
 *
 * Each view is scanned once its own data has actually loaded (`WeddingDetailPage.openTab` waits
 * for network-idle; see that method's own doc comment) and, for the wedding-tabs scan, against a
 * wedding seeded with one real row of everything a tab can render (a guest, a relationship, two
 * tables, a generated plan, a timeline entry, a budget vendor, a comment) rather than every tab's
 * empty state -- a dynamic list row (with its own ARIA labeling, badges, and controls) is exactly
 * where a real accessibility defect is more likely to live than in a static "nothing here yet"
 * message, and this also matches the "drive it through real, populated UI" precedent already
 * established across this suite (e.g. TS-51/TS-52's own UI-driven tests).
 *
 * Uses `@axe-core/playwright` (added as a new devDependency by this story -- no accessibility-
 * scanning package existed in the repo before; `axe-core` itself was already present, but only as
 * a transitive dependency of `eslint-plugin-jsx-a11y`'s static lint rules, not a runtime scanner).
 * See `e2e/support/axeScan.ts` for the shared WCAG-2.1-AA rule-set selection this and the
 * companion keyboard/responsiveness file both reuse.
 *
 * Two real, currently-shipped WCAG 2.1 AA violations were found and fixed while authoring this
 * test (both in `GuestsTab.tsx`, both confirmed with axe-core's own exact numbers before and after
 * the fix -- see that file's own inline comments at each fix site):
 * 1. `color-contrast` (serious): the "no self-RSVP yet" badge's `text-neutral-500` on
 *    `bg-neutral-100` measured 4.34:1 against the 4.5:1 this 12px text needs -- bumped one step
 *    darker to `text-neutral-600` (~6.4:1), the same fix shape README.md's own prior NFR-9.5 pass
 *    already used elsewhere in this app (`text-neutral-400` -> `text-neutral-500`).
 * 2. `label` (critical): the CSV-import `<input type="file">` had no accessible name at all (no
 *    wrapping/explicit `<label>`, no `aria-label`) -- given one directly.
 * Neither was caught by this app's prior, non-automated NFR-9.5 exercise (README.md lines
 * 614-621) -- unsurprising, since that was a one-off manual pass with no regression-preventing
 * test left behind afterward, which is exactly the gap this story exists to close.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { GuestRsvpPage } from "../pages/GuestRsvpPage.js";
import { scanForWcagAaViolations } from "../support/axeScan.js";
import { uniquePersonName } from "../data/ids.js";

/** Runs the shared WCAG-2.1-AA scan against the page's current DOM and asserts zero violations,
 * naming the view and (on failure) every violating rule/element in the assertion message itself
 * -- so a red run points straight at what to fix without needing to re-run locally first. */
async function assertNoWcagAaViolations(page: import("@playwright/test").Page, viewName: string): Promise<void> {
  const result = await scanForWcagAaViolations(page);
  expect(result.violationCount, `${viewName} should have zero WCAG 2.1 AA violations. Found:\n${result.summary}`).toBe(0);
}

defineQualityTest(
  {
    id: "accessibility.automated-axe-scans-find-zero-wcag-aa-violations-on-key-pages.every-authenticated-app-view-is-clean",
    title: "an automated axe-core scan finds zero WCAG 2.1 AA violations on login, signup, the dashboard, and every one of the 10 wedding-detail tabs, each in a realistically populated state",
    objective:
      "Confirms none of the app's 13 authenticated-surface views (login, signup, dashboard, and the Guests/Seating rules/Tables/Seating plan/Day-of mode/Timeline/Budget/Comments/Activity/Collaborators tabs) render any axe-detectable WCAG 2.1 Level AA violation once each tab's own data has finished loading and is showing at least one real row, not just its empty state.",
    expectedOutcome:
      "Each of the 13 views returns zero axe violations under the wcag2a/wcag2aa/wcag21a/wcag21aa rule sets.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:non-functional", "@accessibility", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const guestA = uniquePersonName(token);
    const guestB = uniquePersonName(token);

    await test.step("Arrange: one real row of everything a wedding tab can render", async () => {
      const createdA = await weddingData.createGuest(managedWedding.id, guestA);
      const createdB = await weddingData.createGuest(managedWedding.id, guestB);
      await weddingData.createRelationship(managedWedding.id, createdA.id, createdB.id, "MUST_SIT_TOGETHER");
      await weddingData.createTable(managedWedding.id, { label: "Head Table", capacity: 4 });
      await weddingData.createTable(managedWedding.id, { label: "Guest Table", capacity: 4 });
      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      await weddingData.createTimelineEntry(managedWedding.id, { time: "17:00", description: "Ceremony begins" });
      const vendorRes = await context.request.post(`/api/v1/weddings/${managedWedding.id}/vendors`, {
        data: { name: "Scan Test Catering", category: "CATERING", costCents: 50000 },
      });
      expect(vendorRes.status()).toBe(201);
      const budgetRes = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/budget`, {
        data: { budgetCents: 100000 },
      });
      expect(budgetRes.status()).toBe(200);
      const commentRes = await weddingData.postComment(managedWedding.id, {
        targetType: "GUEST",
        guestId: createdA.id,
        body: "Confirmed dietary restrictions with the caterer.",
      });
      expect(commentRes.status).toBe(201);
    });

    const weddingDetail = new WeddingDetailPage(page);
    await test.step("Assert: the dashboard has zero violations", async () => {
      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");
      await assertNoWcagAaViolations(page, "/dashboard");
    });

    await test.step("Assert: /login has zero violations", async () => {
      await page.goto("/login");
      await assertNoWcagAaViolations(page, "/login");
    });

    await test.step("Assert: /signup has zero violations", async () => {
      await page.goto("/signup");
      await assertNoWcagAaViolations(page, "/signup");
    });

    await test.step("Arrange: open the seeded wedding", async () => {
      await weddingDetail.goto(managedWedding.id);
    });

    const tabLabels = [
      "Guests",
      "Seating rules",
      "Tables",
      "Seating plan",
      "Day-of mode",
      "Timeline",
      "Budget",
      "Comments",
      "Activity",
      "Collaborators",
    ];
    for (const label of tabLabels) {
      await test.step(`Assert: the "${label}" tab has zero violations`, async () => {
        await weddingDetail.openTab(label);
        await assertNoWcagAaViolations(page, `wedding-detail "${label}" tab`);
      });
    }
  },
);

defineQualityTest(
  {
    id: "accessibility.automated-axe-scans-find-zero-wcag-aa-violations-on-key-pages.the-unauthenticated-guest-rsvp-page-is-clean",
    title: "an automated axe-core scan finds zero WCAG 2.1 AA violations on the guest's own, fully unauthenticated RSVP page",
    objective:
      "Confirms the RSVP link a guest actually receives (no sign-in of any kind, per GuestRsvpPage's own header comment) renders with zero axe-detectable WCAG 2.1 Level AA violations, checked in a brand-new browser context with no session at all -- the exact conditions a real guest opens the link under.",
    expectedOutcome: "The RSVP page at /rsvp/:token returns zero axe violations under the wcag2a/wcag2aa/wcag21a/wcag21aa rule sets.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:non-functional", "@accessibility", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    const guest = uniquePersonName(testInfo.workerIndex);
    let rsvpToken = "";

    await test.step("Arrange: a guest and their RSVP link", async () => {
      const created = await weddingData.createGuest(managedWedding.id, guest);
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/guests/${created.id}/rsvp-link`, {
        data: {},
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { rsvp: { url: string } };
      rsvpToken = body.rsvp.url.split("/").pop()!;
    });

    const guestContext = await browser.newContext();
    try {
      const guestPage = await guestContext.newPage();
      const rsvpPage = new GuestRsvpPage(guestPage);
      await test.step("Act + Assert: the RSVP page, opened with no session at all, has zero violations", async () => {
        await rsvpPage.goto(rsvpToken);
        await assertNoWcagAaViolations(guestPage, "/rsvp/:token (guest RSVP page)");
      });
    } finally {
      await guestContext.close();
    }
  },
);
