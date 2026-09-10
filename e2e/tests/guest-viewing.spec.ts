/**
 * Stage 04 — the framework's high-quality READ-ONLY reference test (spec Stage 04 task: "Create a
 * high-quality read-only reference test against a safe project behavior"). Companion to
 * guest-management.spec.ts's mutating reference test.
 *
 * "Read-only" describes the behavior this test itself validates -- viewing an existing guest list
 * makes no application state change -- not "zero writes occur anywhere in the whole test run".
 * Every test in this app necessarily needs an account and a wedding to view anything (there is no
 * public, unauthenticated read surface), so Arrange still creates that precondition data through
 * the real API. The test body's own action (Act) and validation (Assert) never call any mutating
 * endpoint or UI control -- that's what earns the `@readonly` tag and the "safe against production"
 * classification tag validation gives it (spec Section 9.3).
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
    id: "guest-viewing.guest-list-shows-existing-guests",
    title: "a planner can view a guest that already exists on their wedding's guest list",
    objective:
      "Confirms a signed-in planner can open the Guests tab and see a guest that already exists on their wedding, without the test itself making any change through the UI.",
    expectedOutcome:
      "The guest created ahead of time (via the API, not this test's own action) appears in the Guests tab with the correct name and a PENDING RSVP status.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@readonly", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, evidence }, testInfo) => {
    const { firstName, lastName } = await test.step("Arrange: seed one guest directly through the API (not this test's own action under test)", async () => {
      const name = uniquePersonName(testInfo.workerIndex);
      await weddingData.createGuest(managedWedding.id, name);
      return name;
    });

    await test.step("Act: open the wedding's Guests tab (a read, not a write)", async () => {
      await weddingGuestsPage.goto(managedWedding.id);
      await weddingGuestsPage.openGuestsTab();
    });

    await test.step("Assert: the pre-existing guest is visible with its correct name and default RSVP status", async () => {
      const row = weddingGuestsPage.guestRow(`${firstName} ${lastName}`);
      await row.expectVisible();
      await expect.poll(() => row.firstName()).toBe(firstName);
      await expect.poll(() => row.lastName()).toBe(lastName);
      await expect.poll(() => row.rsvpStatus()).toBe("PENDING");
    });

    await evidence.checkpoint(
      "guest-visible-in-list",
      `The pre-existing guest "${firstName} ${lastName}" is visible in the Guests tab with a PENDING RSVP status.`,
    );
  },
);
