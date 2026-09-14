#!/usr/bin/env node
/**
 * Stage 02 — regenerates quality/test-value-model.md from the canonical
 * quality/test-value-model.yaml. Run via `pnpm pw:generate-value-model-md`.
 *
 * Deliberately produces byte-for-byte identical output for identical input (no timestamps, no
 * environment-dependent content): playwright-framework/tests/valueModelMarkdown.spec.ts
 * regenerates the markdown in-memory and diffs it against the committed file, so the committed
 * .md can never silently drift out of sync with the .yaml it's generated from.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadTestValueModel } from "../metadata/loaders.js";
import { renderValueModelMarkdown } from "./renderValueModelMarkdown.js";

function main(): void {
  const yamlPath = resolve(process.cwd(), "quality/test-value-model.yaml");
  const mdPath = resolve(process.cwd(), "quality/test-value-model.md");
  const model = loadTestValueModel(yamlPath);
  const markdown = renderValueModelMarkdown(model);
  writeFileSync(mdPath, markdown, "utf-8");
  // eslint-disable-next-line no-console
  console.log(`Regenerated ${mdPath} from ${yamlPath} (model version ${model.modelVersion}).`);
}

main();
