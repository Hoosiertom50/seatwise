/**
 * Stage 02 — load + parse + validate the quality/*.yaml governance files against their canonical
 * zod schemas (schemas.ts). Every loader throws a MetadataValidationError with a fully-formatted,
 * human-readable message on any failure — malformed YAML, a schema violation, or a cross-file
 * consistency problem — so "invalid or contradictory metadata fails before execution" (Stage 02
 * acceptance criterion) is something a script can actually demonstrate, not just something a unit
 * test asserts in isolation.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import {
  RequirementsFileSchema,
  TagTaxonomyFileSchema,
  TestValueModelFileSchema,
  ValueOverridesFileSchema,
  SavedSelectionsFileSchema,
  TestEvaluationsFileSchema,
  FailureClassificationsFileSchema,
  type RequirementsFile,
  type TagTaxonomyFile,
  type TestValueModelFile,
  type ValueOverridesFile,
  type SavedSelectionsFile,
  type TestEvaluationsFile,
  type FailureClassificationsFile,
} from "./schemas.js";

export class MetadataValidationError extends Error {
  constructor(
    public readonly sourcePath: string,
    public readonly issues: string[],
  ) {
    super(
      `Invalid metadata in ${sourcePath}:\n` + issues.map((issue) => `  - ${issue}`).join("\n"),
    );
    this.name = "MetadataValidationError";
  }
}

function loadYamlFile<Schema extends z.ZodTypeAny>(
  path: string,
  schema: Schema,
): z.infer<Schema> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new MetadataValidationError(path, [
      `could not read file: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new MetadataValidationError(path, [
      `invalid YAML syntax: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new MetadataValidationError(path, issues);
  }
  return result.data;
}

export function loadRequirements(path: string): RequirementsFile {
  return loadYamlFile(path, RequirementsFileSchema);
}

export function loadTagTaxonomy(path: string): TagTaxonomyFile {
  return loadYamlFile(path, TagTaxonomyFileSchema);
}

export function loadTestValueModel(path: string): TestValueModelFile {
  return loadYamlFile(path, TestValueModelFileSchema);
}

export function loadValueOverrides(path: string): ValueOverridesFile {
  return loadYamlFile(path, ValueOverridesFileSchema);
}

export function loadSavedSelections(path: string): SavedSelectionsFile {
  return loadYamlFile(path, SavedSelectionsFileSchema);
}

export function loadTestEvaluations(path: string): TestEvaluationsFile {
  return loadYamlFile(path, TestEvaluationsFileSchema);
}

/** Stage 09 — loads quality/failure-classifications.yaml (the hand-authored half of failure
 * triage; see schemas.ts's module doc above MaintenanceReportSchema). Behaves exactly like every
 * other loader here: a missing file, invalid YAML, or a schema violation throws
 * MetadataValidationError rather than being treated as "no classifications yet" (an intentionally
 * empty `classifications: []` list is how that case is expressed, and parses successfully). */
export function loadFailureClassifications(path: string): FailureClassificationsFile {
  return loadYamlFile(path, FailureClassificationsFileSchema);
}
