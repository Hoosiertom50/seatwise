import { test, expect } from "@playwright/test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRequirements,
  loadTagTaxonomy,
  loadTestValueModel,
  loadValueOverrides,
  MetadataValidationError,
} from "../metadata/loaders.js";

test.describe("real quality/*.yaml files load and validate cleanly", () => {
  test("requirements.yaml", () => {
    const file = loadRequirements("quality/requirements.yaml");
    expect(file.requirements.length).toBeGreaterThan(0);
    const ids = file.requirements.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  test("tag-taxonomy.yaml", () => {
    const file = loadTagTaxonomy("quality/tag-taxonomy.yaml");
    expect(file.dimensions.length).toBeGreaterThan(0);
  });

  test("test-value-model.yaml", () => {
    const file = loadTestValueModel("quality/test-value-model.yaml");
    const valueTotal = file.valueCriteria.reduce((sum, c) => sum + c.weight, 0);
    const qualityTotal = file.qualityCriteria.reduce((sum, c) => sum + c.weight, 0);
    expect(valueTotal).toBe(100);
    expect(qualityTotal).toBe(100);
  });

  test("value-overrides.yaml", () => {
    const file = loadValueOverrides("quality/value-overrides.yaml");
    expect(Array.isArray(file.overrides)).toBe(true);
  });
});

test.describe("malformed metadata fails loudly, before execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-metadata-test-"));

  test("invalid YAML syntax raises MetadataValidationError", () => {
    const path = join(dir, "broken.yaml");
    writeFileSync(path, "schemaVersion: [unclosed\n", "utf-8");
    expect(() => loadRequirements(path)).toThrow(MetadataValidationError);
  });

  test("YAML that fails schema validation raises MetadataValidationError naming the field", () => {
    const path = join(dir, "wrong-shape.yaml");
    writeFileSync(path, "schemaVersion: \"1.0.0\"\nrequirements:\n  - id: \"\"\n", "utf-8");
    let thrown: unknown;
    try {
      loadRequirements(path);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MetadataValidationError);
    expect((thrown as MetadataValidationError).issues.length).toBeGreaterThan(0);
  });

  test("a value model whose weights do not total 100 raises MetadataValidationError", () => {
    const path = join(dir, "bad-weights.yaml");
    writeFileSync(
      path,
      [
        'schemaVersion: "1.0.0"',
        'modelVersion: "1.0.0"',
        'effectiveDate: "2026-01-01"',
        "changeHistory:",
        '  - date: "2026-01-01"',
        '    modelVersion: "1.0.0"',
        '    change: "init"',
        "valueCriteria:",
        '  - id: "a"',
        '    label: "A"',
        "    weight: 50",
        '    question: "q"',
        "    anchors: { \"0\": \"0\", \"25\": \"25\", \"50\": \"50\", \"75\": \"75\", \"100\": \"100\" }",
        '    example: "e"',
        "valueBands:",
        '  - band: "b"',
        "    minScore: 0",
        "    maxScore: 100",
        '    meaning: "m"',
        "qualityCriteria:",
        '  - id: "x"',
        '    label: "X"',
        "    weight: 100",
        '    question: "q"',
        "    anchors: { \"0\": \"0\", \"25\": \"25\", \"50\": \"50\", \"75\": \"75\", \"100\": \"100\" }",
        '    example: "e"',
        "",
      ].join("\n"),
      "utf-8",
    );
    expect(() => loadTestValueModel(path)).toThrow(/weights must total exactly 100/);
  });
});
