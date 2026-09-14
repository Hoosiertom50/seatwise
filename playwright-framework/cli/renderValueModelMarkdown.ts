/**
 * Stage 02 — pure rendering function: TestValueModelFile -> markdown. Separated from
 * generate-value-model-md.ts (which does file I/O) so a unit test can call it directly and
 * assert byte-for-byte reproducibility without touching the filesystem.
 */

import type { ModelCriterion, TestValueModelFile } from "../metadata/schemas.js";

function renderCriterionTable(criteria: ModelCriterion[]): string {
  const rows = criteria
    .map((c) => `| ${c.label} | ${c.weight} | ${c.question} |`)
    .join("\n");
  return `| Criterion | Weight | Scoring question |\n|---|---:|---|\n${rows}`;
}

function renderAnchors(criteria: ModelCriterion[]): string {
  return criteria
    .map((c) => {
      const anchorLines = (["0", "25", "50", "75", "100"] as const)
        .map((pct) => `  - **${pct}%:** ${c.anchors[pct]}`)
        .join("\n");
      return `### ${c.label}\n\n${anchorLines}\n\n  _Example:_ ${c.example}`;
    })
    .join("\n\n");
}

export function renderValueModelMarkdown(model: TestValueModelFile): string {
  const lines: string[] = [];

  lines.push("# Test value and quality model");
  lines.push("");
  lines.push(
    "> **Generated file — do not edit directly.** This is produced from `quality/test-value-model.yaml` by " +
      "`pnpm pw:generate-value-model-md`. Edit the YAML and regenerate instead.",
  );
  lines.push("");
  lines.push(`**Model version:** ${model.modelVersion}  `);
  lines.push(`**Effective date:** ${model.effectiveDate}`);
  lines.push("");
  lines.push("## Principle");
  lines.push("");
  lines.push(
    "Test value and test implementation quality are different concepts and are never merged. " +
      "Value measures business confidence and risk reduction (0-100); quality measures engineering " +
      "craftsmanship (0-100). Neither pass/fail status nor flakiness directly changes a value score.",
  );
  lines.push("");
  lines.push("## Value scoring (100 points)");
  lines.push("");
  lines.push(renderCriterionTable(model.valueCriteria));
  lines.push("");
  lines.push("### Value scoring anchors");
  lines.push("");
  lines.push(renderAnchors(model.valueCriteria));
  lines.push("");
  lines.push("### Value bands");
  lines.push("");
  lines.push("| Score | Band | Meaning |");
  lines.push("|---:|---|---|");
  for (const band of model.valueBands) {
    lines.push(`| ${band.minScore}-${band.maxScore} | ${band.band} | ${band.meaning} |`);
  }
  lines.push("");
  lines.push("## Quality scoring (100 points)");
  lines.push("");
  lines.push(renderCriterionTable(model.qualityCriteria));
  lines.push("");
  lines.push("### Quality scoring anchors");
  lines.push("");
  lines.push(renderAnchors(model.qualityCriteria));
  lines.push("");
  lines.push("## Change history");
  lines.push("");
  lines.push("| Date | Model version | Change |");
  lines.push("|---|---|---|");
  for (const entry of model.changeHistory) {
    lines.push(`| ${entry.date} | ${entry.modelVersion} | ${entry.change} |`);
  }
  lines.push("");

  return lines.join("\n");
}
