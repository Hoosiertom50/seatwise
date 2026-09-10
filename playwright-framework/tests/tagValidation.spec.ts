import { test, expect } from "@playwright/test";
import { validateTags, resolveAliases } from "../metadata/tagValidation.js";
import type { TagTaxonomyFile } from "../metadata/schemas.js";

const taxonomy: TagTaxonomyFile = {
  schemaVersion: "1.0.0",
  changeHistory: [{ date: "2026-01-01", change: "init" }],
  dimensions: [
    {
      name: "data-impact",
      description: "d",
      requirement: "exactly-one",
      tags: [
        { name: "@readonly", description: "d", productionEligible: true },
        { name: "@mutating", description: "d", productionEligible: false },
      ],
    },
    {
      name: "feature",
      description: "d",
      requirement: "at-least-one",
      tags: [
        { name: "@feature:a", description: "d", productionEligible: true },
        { name: "@feature:b", description: "d", productionEligible: true },
      ],
    },
    {
      name: "lifecycle",
      description: "d",
      requirement: "optional",
      tags: [{ name: "@quarantined", description: "d", productionEligible: false }],
    },
  ],
  conflicts: [{ tags: ["@readonly", "@mutating"], reason: "mutually exclusive" }],
  aliases: [{ alias: "@ro", canonical: "@readonly" }],
};

test.describe("validateTags", () => {
  test("passes a tag set satisfying every dimension requirement", () => {
    const result = validateTags(["@readonly", "@feature:a"], taxonomy);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("fails on an unknown tag", () => {
    const result = validateTags(["@readonly", "@feature:a", "@not-real"], taxonomy);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("@not-real"))).toBe(true);
  });

  test("fails when an exactly-one dimension has zero matches", () => {
    const result = validateTags(["@feature:a"], taxonomy);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("data-impact"))).toBe(true);
  });

  test("fails when an exactly-one dimension has two matches", () => {
    const result = validateTags(["@readonly", "@mutating", "@feature:a"], taxonomy);
    expect(result.valid).toBe(false);
    // Both the dimension-count rule and the explicit conflict rule should fire.
    expect(result.errors.some((e) => e.includes("data-impact"))).toBe(true);
    expect(result.errors.some((e) => e.includes("conflicting tags"))).toBe(true);
  });

  test("fails when an at-least-one dimension has zero matches", () => {
    const result = validateTags(["@readonly"], taxonomy);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("feature"))).toBe(true);
  });

  test("optional dimension with zero matches does not fail", () => {
    const result = validateTags(["@readonly", "@feature:a"], taxonomy);
    expect(result.errors.some((e) => e.includes("lifecycle"))).toBe(false);
  });

  test("resolves an alias to its canonical tag before validating", () => {
    const resolved = resolveAliases(["@ro", "@feature:a"], taxonomy);
    expect(resolved).toEqual(["@readonly", "@feature:a"]);
    const result = validateTags(["@ro", "@feature:a"], taxonomy);
    expect(result.valid).toBe(true);
    expect(result.resolvedTags).toEqual(["@readonly", "@feature:a"]);
  });
});
