import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { loadTestValueModel } from "../metadata/loaders.js";
import { renderValueModelMarkdown } from "../cli/renderValueModelMarkdown.js";

test.describe("quality/test-value-model.md stays in sync with test-value-model.yaml", () => {
  test("regenerating from the committed YAML reproduces the committed markdown byte-for-byte", () => {
    const model = loadTestValueModel("quality/test-value-model.yaml");
    const regenerated = renderValueModelMarkdown(model);
    const committed = readFileSync("quality/test-value-model.md", "utf-8");
    expect(regenerated).toBe(committed);
  });

  test("rendering is deterministic across repeated calls with the same input", () => {
    const model = loadTestValueModel("quality/test-value-model.yaml");
    expect(renderValueModelMarkdown(model)).toBe(renderValueModelMarkdown(model));
  });
});
