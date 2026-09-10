/**
 * Stage 03 — a real, running reference test exercising the full fixture stack end to end:
 * `defineQualityTest` (Stage 02 governed metadata, validated against the live tag taxonomy),
 * `account` (a freshly signed-up user, no embedded credentials), `managedWedding` (test-data
 * setup + cleanup via the real API), `weddingGuestsPage`/`GuestRow` (page/component objects), and
 * `evidence` (a named success-checkpoint screenshot). This is the first real application test in
 * the repository to use `defineQualityTest` — closing the "proven only against synthetic
 * fixtures" gap Stage 02's independent audit disclosed. The framework's high-quality MUTATING
 * reference test (Stage 04 task); see guest-viewing.spec.ts for its read-only companion.
 *
 * Structured with named `test.step` calls for Arrange/Act/Assert (spec Stage 04 task: "Define
 * Arrange/Act/Assert and named test.step expectations") so the HTML report's step list reads as
 * the test's own narrative, and so a reviewer can see which phase failed without reading the
 * implementation.
 */

import { defineQualityTest, expect, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "guest-management.add-guest-appears-in-list",
    title: "a planner can add a guest and see it in the guest list",
    objective:
      "Confirms a signed-in planner can add a guest to one of their weddings and immediately see that guest reflected in the guest list.",
    expectedOutcome:
      "After submitting the add-guest form, a row for the new guest appears in the Guests tab showing their name.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingGuestsPage, evidence }, testInfo) => {
    // Guest names are constrained by the app's PERSON_NAME_PATTERN (letters/spaces/apostrophes/
    // periods/hyphens -- no digits), so uniqueness comes from uniquePersonName's letters-only
    // encoding rather than embedding testInfo.workerIndex/.retry directly.
    const { firstName, lastName } = await test.step("Arrange: open the wedding's Guests tab", async () => {
      await weddingGuestsPage.goto(managedWedding.id);
      await weddingGuestsPage.openGuestsTab();
      return uniquePersonName(testInfo.workerIndex);
    });

    await test.step("Act: submit the add-guest form", async () => {
      await weddingGuestsPage.addGuest({ firstName, lastName });
    });

    const row = weddingGuestsPage.guestRow(`${firstName} ${lastName}`);

    await test.step("Assert: the new guest appears in the list with the expected name and default RSVP status", async () => {
      await row.expectVisible();
      // Reads the editable-name inputs' values, not the row's text content -- see
      // GuestRow.firstName's own doc comment for why toContainText/hasText against this row would
      // silently match nothing.
      await expect.poll(() => row.firstName()).toBe(firstName);
      await expect.poll(() => row.lastName()).toBe(lastName);
      // Default RSVP status for a newly added guest is PENDING (createGuestSchema's default) --
      // exercise the GuestRow component object's read path too, not only addGuest's write path.
      await expect.poll(() => row.rsvpStatus()).toBe("PENDING");
    });

    await evidence.checkpoint(
      "guest-added",
      `The new guest "${firstName} ${lastName}" appears as a row in the Guests tab list.`,
    );
  },
);
