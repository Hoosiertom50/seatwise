/**
 * Stage 09 — renders a validated `MaintenanceReport` (playwright-framework/metadata/schemas.ts)
 * into a single, self-contained HTML file, following the same conventions Stage 06/07's report
 * renderers already established: no external stylesheets/scripts/fonts/network requests, every
 * dynamic string HTML-escaped (`esc`), a real semantic heading hierarchy, `<details>/<summary>` for
 * per-finding expansion, and status conveyed by a text word AND a symbol together (never color
 * alone).
 */

import { relative, sep } from "node:path";
import type { MaintenanceReport, MaintenanceFinding, FailureClassification } from "../metadata/schemas.js";
import { MAINTENANCE_REPORT_DIR } from "./constants.js";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toHref(repoRelativePath: string): string {
  return relative(MAINTENANCE_REPORT_DIR, repoRelativePath).split(sep).join("/");
}

interface ClassificationMeta {
  label: string;
  symbol: string;
}

const CLASSIFICATION_META: Record<FailureClassification, ClassificationMeta> = {
  "probable-application-defect": { label: "Probable application defect", symbol: "⚠" }, // ⚠
  "probable-test-defect": { label: "Probable test defect", symbol: "✎" }, // ✎
  "intended-application-change": { label: "Intended application change", symbol: "→" }, // →
  "test-data-problem": { label: "Test-data problem", symbol: "⚙" }, // ⚙ (reused, data-shaped)
  "environment-or-infrastructure-problem": { label: "Environment or infrastructure problem", symbol: "⚙✗" }, // ⚙✗
  "intermittent-flaky-behavior": { label: "Intermittent/flaky behavior", symbol: "↻" }, // ↻
  "insufficient-evidence": { label: "Insufficient evidence", symbol: "?" },
};

function renderEvidenceList(label: string, items: string[]): string {
  if (items.length === 0) return `<p class="evidence-empty"><strong>${esc(label)}:</strong> none recorded.</p>`;
  return `<div class="evidence-group"><strong>${esc(label)}:</strong><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`;
}

function renderFinding(finding: MaintenanceFinding): string {
  const meta = CLASSIFICATION_META[finding.classification];
  const reviewBadge = finding.needsHumanReview
    ? `<span class="badge badge-review">⚠ Needs human review</span>`
    : `<span class="badge badge-ok">✓ No further review flagged</span>`;
  const repairBadge = finding.repairAllowed
    ? `<span class="badge badge-repair-candidate">Repair candidate (still requires explicit human confirmation)</span>`
    : `<span class="badge badge-repair-blocked">Repair not allowed</span>`;

  return `<details class="finding" data-classification="${esc(finding.classification)}" data-test-id="${esc(finding.testId)}">
  <summary>
    <span class="badge badge-classification"><span aria-hidden="true">${meta.symbol}</span> ${esc(meta.label)}</span>
    <span class="badge badge-confidence badge-confidence-${esc(finding.confidence)}">Confidence: ${esc(finding.confidence)}</span>
    ${reviewBadge}
    ${repairBadge}
    <code class="test-id">${esc(finding.testId)}</code>
  </summary>
  <div class="finding-body">
    <p class="source-tag">Source of this classification: <strong>${esc(finding.source)}</strong> &middot; run <code>${esc(finding.runId)}</code></p>

    <h4>Expected vs. observed behavior</h4>
    <p><strong>Expected:</strong> ${esc(finding.expectedBehavior)}</p>
    <p><strong>Observed:</strong> ${esc(finding.observedBehavior)}</p>
    ${finding.firstFailedStep ? `<p><strong>First failed step:</strong> ${esc(finding.firstFailedStep)}</p>` : ""}

    <h4>Comparison notes</h4>
    <p>${esc(finding.comparisonNotes)}</p>

    <h4>Evidence</h4>
    ${renderEvidenceList("For an application defect", finding.evidenceForApplicationDefect)}
    ${renderEvidenceList("Against an application defect", finding.evidenceAgainstApplicationDefect)}
    ${renderEvidenceList("For a test defect", finding.evidenceForTestDefect)}
    ${renderEvidenceList("Against a test defect", finding.evidenceAgainstTestDefect)}

    <h4>Evidence links</h4>
    <ul class="evidence-links">
      ${finding.evidenceLinks.map((l) => `<li><a href="${esc(toHref(l.path))}">${esc(l.label)}</a></li>`).join("")}
    </ul>

    <h4>Recommendation</h4>
    <p>${esc(finding.recommendedNextAction)}</p>
    ${finding.suggestedDefectDescription ? `<p><strong>Suggested defect description:</strong> ${esc(finding.suggestedDefectDescription)}</p>` : ""}
    ${finding.repairAllowed ? `<p class="repair-scope"><strong>Files a repair may modify:</strong> ${finding.repairAllowedFiles.map((f) => `<code>${esc(f)}</code>`).join(", ")}</p>` : ""}
  </div>
</details>`;
}

export function renderMaintenanceReportHtml(report: MaintenanceReport): string {
  const byClassification = new Map<string, number>();
  for (const f of report.findings) byClassification.set(f.classification, (byClassification.get(f.classification) ?? 0) + 1);

  const summaryRows = Object.keys(CLASSIFICATION_META)
    .map((c) => c as FailureClassification)
    .filter((c) => (byClassification.get(c) ?? 0) > 0)
    .map((c) => `<tr><td>${esc(CLASSIFICATION_META[c].label)}</td><td>${byClassification.get(c)}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maintenance report ${esc(report.reportId)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 60rem; margin-inline: auto; line-height: 1.5; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.2rem; margin-top: 2rem; }
  h4 { margin-bottom: 0.25rem; }
  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #8888; padding: 0.35rem 0.75rem; text-align: left; }
  .finding { border: 1px solid #8886; border-radius: 0.4rem; margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; }
  .finding summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .finding-body { margin-top: 0.75rem; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 1rem; font-size: 0.85rem; border: 1px solid #8886; }
  .badge-review { border-color: #c77; }
  .badge-ok { border-color: #383; }
  .badge-repair-candidate { border-color: #37c; }
  .badge-repair-blocked { border-color: #888; opacity: 0.8; }
  .test-id { font-size: 0.85rem; opacity: 0.8; }
  .evidence-group ul { margin: 0.15rem 0 0.5rem 1.25rem; }
  .evidence-empty { opacity: 0.7; font-size: 0.9rem; }
  .evidence-links a { word-break: break-all; }
  code { font-size: 0.9em; }
</style>
</head>
<body>
  <h1>Maintenance report</h1>
  <p>
    Report <code>${esc(report.reportId)}</code> &middot; generated ${esc(report.generatedAt)} &middot;
    framework version ${esc(report.frameworkVersion)} &middot; source run <code>${esc(report.sourceRunId)}</code>
  </p>

  <h2>Summary</h2>
  ${report.findings.length === 0 ? `<p>No real failures were found in this run to triage.</p>` : `<table><thead><tr><th scope="col">Classification</th><th scope="col">Count</th></tr></thead><tbody>${summaryRows}</tbody></table>`}

  <h2>Findings</h2>
  ${report.findings.length === 0 ? "" : report.findings.map((f) => renderFinding(f)).join("\n")}
</body>
</html>
`;
}
