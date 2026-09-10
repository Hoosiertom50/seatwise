import { test, expect } from "@playwright/test";
import { discoverTestMetadataFromSource } from "../validation/discoverTestMetadata.js";
import { CLEAN_TEST } from "./fixtures/badPatternSnippets.js";

test.describe("discoverTestMetadataFromSource", () => {
  test("extracts a well-formed defineQualityTest metadata literal", () => {
    const result = discoverTestMetadataFromSource("fixture.spec.ts", CLEAN_TEST);
    expect(result.parseErrors).toEqual([]);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].metadata.id).toBe("example.clean-reference");
    expect(result.tests[0].metadata.tags).toEqual([
      "@readonly",
      "@feature:guests",
      "@risk:normal",
      "@suite:regression",
    ]);
    expect(result.tests[0].metadata.requirementIds).toEqual(["REQ-GUEST-LIST-MANAGEMENT"]);
    expect(result.tests[0].filePath).toBe("fixture.spec.ts");
    expect(result.tests[0].line).toBeGreaterThan(0);
  });

  test("finds multiple defineQualityTest calls in one file", () => {
    const source = `
      defineQualityTest({ id: "a.one", title: "t1", objective: "o1", expectedOutcome: "e1", requirementIds: ["R1"], tags: ["@readonly"] }, async () => {});
      defineQualityTest({ id: "a.two", title: "t2", objective: "o2", expectedOutcome: "e2", requirementIds: ["R1"], tags: ["@readonly"] }, async () => {});
    `;
    const result = discoverTestMetadataFromSource("fixture.spec.ts", source);
    expect(result.tests.map((t) => t.metadata.id)).toEqual(["a.one", "a.two"]);
  });

  test("reports a parse error when the metadata argument is a variable rather than a literal", () => {
    const source = `
      const metadata = buildMetadata();
      defineQualityTest(metadata, async () => {});
    `;
    const result = discoverTestMetadataFromSource("fixture.spec.ts", source);
    expect(result.tests).toEqual([]);
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0].message).toContain("not a plain object literal");
  });

  test("reports a parse error when a field value is computed rather than a literal", () => {
    const source = `
      defineQualityTest({ id: idFromSomewhere(), title: "t", objective: "o", expectedOutcome: "e", requirementIds: [], tags: [] }, async () => {});
    `;
    const result = discoverTestMetadataFromSource("fixture.spec.ts", source);
    expect(result.tests).toEqual([]);
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0].message).toContain("non-literal value");
  });

  test("reports a parse error when a required field is missing", () => {
    const source = `
      defineQualityTest({ id: "a.one", title: "t1" }, async () => {});
    `;
    const result = discoverTestMetadataFromSource("fixture.spec.ts", source);
    expect(result.tests).toEqual([]);
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0].message).toContain("missing one or more required fields");
  });

  test("a file with no defineQualityTest calls at all produces no tests and no parse errors", () => {
    const result = discoverTestMetadataFromSource("fixture.spec.ts", `import { test } from "@playwright/test";`);
    expect(result.tests).toEqual([]);
    expect(result.parseErrors).toEqual([]);
  });
});
