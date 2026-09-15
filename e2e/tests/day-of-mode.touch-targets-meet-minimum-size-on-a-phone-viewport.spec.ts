/**
 * TS-45 (REQ-DAY-OF-EMERGENCY-MODE) — converts AC-063 ("Day-of mode is usable and meets
 * touch-target size on a phone").
 *
 * Confirmed directly in DayOfTab.tsx's own header comment and every one of its interactive
 * elements: "Every actionable control here targets ~44px (min-h-11) since FR-8.4 calls for this to
 * work with a thumb, not a mouse." Rather than asserting on the CSS class name (which says nothing
 * about what actually renders), this test measures real rendered bounding boxes at an iPhone-sized
 * viewport and asserts each is at least 44 CSS pixels tall -- the same touch-target minimum this
 * component's own source cites (Tailwind's `min-h-11` = `2.75rem` = 44px at the default 16px root
 * font size).
 *
 * Covers the search input, the "Mark not attending" button on a real guest row, the "Add walk-in"
 * submit button, and the "Swap" button (once two guests are seated) -- the concrete set of Day-of
 * mode's own actionable controls, not every element on the page.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";

const MIN_TOUCH_TARGET_PX = 44;

defineQualityTest(
  {
    id: "day-of-mode.touch-targets-meet-minimum-size-on-a-phone-viewport.every-actionable-control-is-at-least-44px-tall",
    title: "on an iPhone-sized viewport, every Day-of mode actionable control (search, mark-attending, add-walk-in, swap) renders at least 44px tall",
    objective:
      "Confirms Day-of mode's real, rendered touch targets -- not just their CSS class names -- are each at least 44 CSS pixels tall at a phone viewport width, satisfying FR-8.4's thumb-sized-control requirement.",
    expectedOutcome:
      "At a 390x844 (iPhone-sized) viewport, the guest-search input, a guest row's 'Mark not attending' button, the 'Add walk-in' submit button, and the 'Swap' button (once two guests are seated) each have a measured bounding-box height of at least 44px.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const dayOf = new DayOfTabPage(page);

    const guestA = uniquePersonName(token);
    const guestB = uniquePersonName(token);
    const guestAName = `${guestA.firstName} ${guestA.lastName}`;

    await test.step("Arrange: two guests, each seated at their own table (so the Swap control renders too)", async () => {
      await weddingData.createGuest(managedWedding.id, guestA);
      await weddingData.createGuest(managedWedding.id, guestB);
      await weddingData.createTable(managedWedding.id, { label: "Phone Table A", capacity: 1 });
      await weddingData.createTable(managedWedding.id, { label: "Phone Table B", capacity: 1 });
      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
    });

    await test.step("Act: set an iPhone-sized viewport and open Day-of mode", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await dayOf.goto(managedWedding.id);
    });

    async function assertAtLeastMinTouchTarget(locator: ReturnType<typeof page.locator>, label: string) {
      const box = await locator.boundingBox();
      expect(box, `${label} should have a measurable bounding box`).not.toBeNull();
      expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }

    await test.step("Assert: the guest-search input meets the touch-target minimum", async () => {
      await assertAtLeastMinTouchTarget(dayOf.searchInputLocator(), "guest search input");
    });

    await test.step("Assert: a guest row's 'Mark not attending' button meets the touch-target minimum", async () => {
      await assertAtLeastMinTouchTarget(dayOf.attendanceButtonLocator(guestAName), "Mark not attending button");
    });

    await test.step("Assert: the 'Add walk-in' submit button meets the touch-target minimum", async () => {
      await assertAtLeastMinTouchTarget(dayOf.addWalkInButtonLocator(), "Add walk-in button");
    });

    await test.step("Assert: the 'Swap' button meets the touch-target minimum", async () => {
      await assertAtLeastMinTouchTarget(dayOf.swapButtonLocator(), "Swap button");
    });
  },
);
