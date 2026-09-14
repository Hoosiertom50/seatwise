#!/usr/bin/env node
/**
 * Stage 02 — validates every quality/*.yaml governance file, plus the cross-file consistency
 * rules that a single file's own schema can't express on its own (unique requirement IDs, unique
 * tag names, override references pointing at real criteria, alias/conflict tags that actually
 * exist). Exits non-zero with a full list of problems on any failure.
 *
 * Run via `pnpm pw:validate-metadata`. Also wired into `pnpm pw:validate` (tsc + this + the
 * framework's own test listing) so "invalid metadata fails before execution" is something anyone
 * can run and see, not just something asserted in a unit test.
 */

import { resolve } from "node:path";
import {
  loadRequirements,
  loadTagTaxonomy,
  loadTestValueModel,
  loadValueOverrides,
  MetadataValidationError,
} from "../metadata/loaders.js";

function fail(messages: string[]): never {
  // eslint-disable-next-line no-console
  console.error("Metadata validation FAILED:\n");
  for (const message of messages) {
    // eslint-disable-next-line no-console
    console.error(`- ${message}`);
  }
  process.exit(1);
}

function main(): void {
  const root = process.cwd();
  const crossFileIssues: string[] = [];

  let requirements, taxonomy, valueModel, overrides;
  try {
    requirements = loadRequirements(resolve(root, "quality/requirements.yaml"));
    taxonomy = loadTagTaxonomy(resolve(root, "quality/tag-taxonomy.yaml"));
    valueModel = loadTestValueModel(resolve(root, "quality/test-value-model.yaml"));
    overrides = loadValueOverrides(resolve(root, "quality/value-overrides.yaml"));
  } catch (err) {
    if (err instanceof MetadataValidationError) {
      fail([err.message]);
    }
    throw err;
  }

  // Unique requirement IDs.
  const requirementCounts = new Map<string, number>();
  for (const req of requirements.requirements) {
    requirementCounts.set(req.id, (requirementCounts.get(req.id) ?? 0) + 1);
  }
  for (const [id, count] of requirementCounts) {
    if (count > 1) {
      crossFileIssues.push(`requirements.yaml: duplicate requirement id "${id}" (${count}x)`);
    }
  }

  // Unique tag names across all dimensions.
  const tagCounts = new Map<string, number>();
  for (const dimension of taxonomy.dimensions) {
    for (const tag of dimension.tags) {
      tagCounts.set(tag.name, (tagCounts.get(tag.name) ?? 0) + 1);
    }
  }
  for (const [name, count] of tagCounts) {
    if (count > 1) {
      crossFileIssues.push(`tag-taxonomy.yaml: tag "${name}" defined ${count} times across dimensions`);
    }
  }

  // Aliases and conflicts must reference tags that actually exist.
  const knownTags = new Set(tagCounts.keys());
  for (const alias of taxonomy.aliases) {
    if (!knownTags.has(alias.canonical)) {
      crossFileIssues.push(
        `tag-taxonomy.yaml: alias "${alias.alias}" points to unknown canonical tag "${alias.canonical}"`,
      );
    }
  }
  for (const conflict of taxonomy.conflicts) {
    for (const tag of conflict.tags) {
      if (!knownTags.has(tag)) {
        crossFileIssues.push(`tag-taxonomy.yaml: conflict references unknown tag "${tag}"`);
      }
    }
  }

  // Override criterionId must exist in either the value or quality criteria of the model.
  const knownCriterionIds = new Set([
    ...valueModel.valueCriteria.map((c) => c.id),
    ...valueModel.qualityCriteria.map((c) => c.id),
  ]);
  for (const override of overrides.overrides) {
    if (override.overrideType === "criterion-score" && override.criterionId) {
      if (!knownCriterionIds.has(override.criterionId)) {
        crossFileIssues.push(
          `value-overrides.yaml: override for test "${override.testId}" references unknown criterion "${override.criterionId}"`,
        );
      }
    }
  }

  if (crossFileIssues.length > 0) {
    fail(crossFileIssues);
  }

  // eslint-disable-next-line no-console
  console.log(
    `Metadata OK: ${requirements.requirements.length} requirements, ` +
      `${taxonomy.dimensions.length} tag dimensions (${knownTags.size} tags), ` +
      `value model ${valueModel.modelVersion} ` +
      `(${valueModel.valueCriteria.length} value + ${valueModel.qualityCriteria.length} quality criteria), ` +
      `${overrides.overrides.length} overrides.`,
  );
}

main();
