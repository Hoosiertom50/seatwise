/**
 * Stage 02 — validates a set of tags against the canonical tag taxonomy (Section 9.1):
 * unknown tags fail, dimension requirements ("exactly-one" / "at-least-one") are enforced,
 * conflicting tag pairs fail, and aliases resolve to their canonical tag before any of the above
 * runs (so `@mutating-write` as an alias for `@mutating` behaves identically to the real tag).
 */

import type { TagTaxonomyFile } from "./schemas.js";

export interface TagValidationResult {
  valid: boolean;
  /** Tags after alias resolution — what validation actually ran against. */
  resolvedTags: string[];
  errors: string[];
}

export function resolveAliases(tags: string[], taxonomy: TagTaxonomyFile): string[] {
  const aliasMap = new Map(taxonomy.aliases.map((a) => [a.alias, a.canonical]));
  return tags.map((tag) => aliasMap.get(tag) ?? tag);
}

export function validateTags(tags: string[], taxonomy: TagTaxonomyFile): TagValidationResult {
  const errors: string[] = [];
  const resolvedTags = resolveAliases(tags, taxonomy);

  const knownTags = new Map<string, string>(); // tag name -> dimension name
  for (const dimension of taxonomy.dimensions) {
    for (const tag of dimension.tags) {
      knownTags.set(tag.name, dimension.name);
    }
  }

  // Unknown tags fail metadata validation (Section 9.1).
  for (const tag of resolvedTags) {
    if (!knownTags.has(tag)) {
      errors.push(`unknown tag "${tag}" is not defined in the tag taxonomy`);
    }
  }

  // Dimension requirements: exactly-one / at-least-one / optional.
  for (const dimension of taxonomy.dimensions) {
    const dimensionTagNames = new Set(dimension.tags.map((t) => t.name));
    const matches = resolvedTags.filter((tag) => dimensionTagNames.has(tag));
    if (dimension.requirement === "exactly-one" && matches.length !== 1) {
      errors.push(
        `dimension "${dimension.name}" requires exactly one tag, found ${matches.length}` +
          (matches.length > 0 ? ` (${matches.join(", ")})` : ""),
      );
    }
    if (dimension.requirement === "at-least-one" && matches.length < 1) {
      errors.push(`dimension "${dimension.name}" requires at least one tag, found none`);
    }
  }

  // Conflicts: no two tags from a declared conflict set may appear together.
  for (const conflict of taxonomy.conflicts) {
    const present = conflict.tags.filter((tag) => resolvedTags.includes(tag));
    if (present.length >= 2) {
      errors.push(
        `conflicting tags present: ${present.join(", ")} (${conflict.reason})`,
      );
    }
  }

  return { valid: errors.length === 0, resolvedTags, errors };
}
