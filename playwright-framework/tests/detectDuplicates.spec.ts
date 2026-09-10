import { test, expect } from "@playwright/test";
import {
  detectDuplicates,
  objectiveSimilarity,
  type DuplicateDetectionTestInput,
} from "../coverage/detectDuplicates.js";

test.describe("objectiveSimilarity", () => {
  test("identical text is similarity 1", () => {
    expect(objectiveSimilarity("adds a guest to the list", "adds a guest to the list")).toBe(1);
  });

  test("completely disjoint text is similarity 0", () => {
    expect(objectiveSimilarity("adds a guest", "deletes a table")).toBe(0);
  });

  test("empty text never divides by zero", () => {
    expect(objectiveSimilarity("", "adds a guest")).toBe(0);
    expect(objectiveSimilarity("adds a guest", "")).toBe(0);
  });
});

test.describe("detectDuplicates", () => {
  test("the real suite's two current tests (shared requirement, different data-impact) are NOT flagged", () => {
    // Reproduces the real guest-viewing/guest-management pair: same requirement + feature, but one
    // is @readonly (views a pre-existing guest) and the other @mutating (adds a new one) -- genuinely
    // different actions that must never be flagged as duplicates on requirement-overlap alone.
    const tests: DuplicateDetectionTestInput[] = [
      {
        testId: "guest-viewing.guest-list-shows-existing-guests",
        tags: ["@readonly", "@feature:guests", "@risk:normal", "@suite:regression"],
        requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
        objective:
          "Confirms a signed-in planner can open the Guests tab and see a guest that already exists on their wedding, without the test itself making any change through the UI.",
      },
      {
        testId: "guest-management.add-guest-appears-in-list",
        tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
        requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
        objective:
          "Confirms a signed-in planner can add a guest to one of their weddings and immediately see that guest reflected in the guest list.",
      },
    ];
    expect(detectDuplicates(tests)).toEqual([]);
  });

  test("two tests with the same requirement, feature, data-impact, and near-identical objectives ARE flagged", () => {
    const tests: DuplicateDetectionTestInput[] = [
      {
        testId: "guests.a",
        tags: ["@readonly", "@feature:guests", "@risk:normal"],
        requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
        objective: "Confirms a signed-in planner can view an existing guest in the guest list",
      },
      {
        testId: "guests.b",
        tags: ["@readonly", "@feature:guests", "@risk:low"],
        requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
        objective: "Confirms a signed-in planner can view an existing guest in the guest list view",
      },
    ];
    const candidates = detectDuplicates(tests);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].testIds.sort()).toEqual(["guests.a", "guests.b"]);
    expect(candidates[0].sharedRequirementIds).toEqual(["REQ-GUEST-LIST-MANAGEMENT"]);
    expect(candidates[0].objectiveSimilarity).toBeGreaterThanOrEqual(0.5);
  });

  test("no shared requirement means never flagged, regardless of tag/objective overlap", () => {
    const tests: DuplicateDetectionTestInput[] = [
      {
        testId: "a",
        tags: ["@readonly", "@feature:guests"],
        requirementIds: ["REQ-ONE"],
        objective: "views the guest list",
      },
      {
        testId: "b",
        tags: ["@readonly", "@feature:guests"],
        requirementIds: ["REQ-TWO"],
        objective: "views the guest list",
      },
    ];
    expect(detectDuplicates(tests)).toEqual([]);
  });

  test("no shared feature tag means never flagged, even with a shared requirement and data-impact", () => {
    const tests: DuplicateDetectionTestInput[] = [
      {
        testId: "a",
        tags: ["@readonly", "@feature:guests"],
        requirementIds: ["REQ-SHARED"],
        objective: "views the guest list",
      },
      {
        testId: "b",
        tags: ["@readonly", "@feature:tables"],
        requirementIds: ["REQ-SHARED"],
        objective: "views the guest list",
      },
    ];
    expect(detectDuplicates(tests)).toEqual([]);
  });

  test("low objective similarity below the threshold is not flagged even with every tag matching", () => {
    const tests: DuplicateDetectionTestInput[] = [
      {
        testId: "a",
        tags: ["@readonly", "@feature:guests"],
        requirementIds: ["REQ-SHARED"],
        objective: "confirms the RSVP status renders correctly for a pending guest",
      },
      {
        testId: "b",
        tags: ["@readonly", "@feature:guests"],
        requirementIds: ["REQ-SHARED"],
        objective: "confirms bulk CSV export produces one row per guest with all columns",
      },
    ];
    expect(detectDuplicates(tests)).toEqual([]);
  });
});
