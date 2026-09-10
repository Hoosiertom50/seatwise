/**
 * Stage 03 — a real, running reference test exercising the full fixture stack end to end:
 * `defineQualityTest` (Stage 02 governed metadata, validated against the live tag taxonomy),
 * `account` (a freshly signed-up user, no embedded credentials), `managedWedding` (test-data
 * setup + cleanup via the real API), `weddingGuestsPage`/`GuestRow` (page/component objects), and
 * `evidence` (a named success-checkpoint screenshot). This is the first real application test in
 * the repository to use `defineQualityTest` — closing the "proven only against synthetic
 * fixtures" gap Stage 02's independent audit disclosed.
 */

import { defineQualityTest, expect } from "../fixtures/index.js";
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
    await weddingGuestsPage.goto(managedWedding.id);
    await weddingGuestsPage.openGuestsTab();

    // Guest names are constrained by the app's PERSON_NAME_PATTERN (letters/spaces/apostrophes/
    // periods/hyphens -- no digits), so uniqueness comes from uniquePersonName's letters-only
    // encoding rather than embedding testInfo.workerIndex/.retry directly.
    const { firstName, lastName } = uniquePersonName(testInfo.workerIndex);
    await weddingGuestsPage.addGuest({ firstName, lastName });

    const row = weddingGuestsPage.guestRow(`${firstName} ${lastName}`);
    await row.expectVisible();
    // Reads the editable-name inputs' values, not the row's text content -- see GuestRow.firstName's
    // own doc comment for why toContainText/hasText against this row would silently match nothing.
    await expect.poll(() => row.firstName()).toBe(firstName);
    await expect.poll(() => row.lastName()).toBe(lastName);

    await evidence.checkpoint(
      "guest-added",
      `The new guest "${firstName} ${lastName}" appears as a row in the Guests tab list.`,
    );

    // Default RSVP status for a newly added guest is PENDING (createGuestSchema's default) --
    // exercise the GuestRow component object's read path too, not only addGuest's write path.
    await expect.poll(() => row.rsvpStatus()).toBe("PENDING");
  },
);
