/**
 * Stage 07 — renders a validated `SuiteReview` (playwright-framework/metadata/schemas.ts) into a
 * single, self-contained HTML file, following the exact same posture Stage 06's
 * `renderRunReportHtml.ts` established (Section 10.1/10.3: self-contained, offline-viewable, no
 * external stylesheets/scripts/fonts/network calls, every dynamic string escaped, a real semantic
 * heading hierarchy, `<table>`/`<th scope>` for tabular data, `<details>/<summary>` for per-test
 * expansion, status conveyed by symbol+text never color alone, and filter controls built from real
 * `<input>`/`<select>` elements reachable by Tab, filtered by plain client-side JS with no
 * client-side re-fetch of anything).
 *
 * Covers every Section 10.3 bullet: current model/version, requirement/risk-weighted/dimension
 * coverage with each bucket's own denominator/exclusion label, duplicate candidates, value/quality
 * score distributions, the prioritized review queue, changes from the previous review (when one
 * exists), and a full itemized test catalog carrying all 13 required per-test fields with filters
 * for feature/risk/result/freshness/quarantine/review status.
 */

import { relative, sep } from "node:path";
import type { SuiteReview, SuiteReviewTestEntry, CriterionResultShape, ScoreResultShape } from "../metadata/schemas.js";

/** Where the suite-review CLI writes this HTML file -- kept as a local constant analogous to
 * `reporting/constants.ts`'s `REPORT_DIR`, but not the same directory: run reports and suite
 * reviews are sibling directories under artifacts/playwright/runs/, so relative hrefs to a test's
 * source file are computed from here, not from `REPORT_DIR`. */
const SUITE_REVIEW_DIR = "artifacts/playwright/runs/suite-reviews";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pct(covered: number, total: number): string {
  if (total === 0) return "n/a (no eligible denominator)";
  return `${((covered / total) * 100).toFixed(1)}%`;
}

/** A repo-root-relative path turned into an href that resolves from this file's own location on
 * disk -- suite reviews and run reports are sibling directories under artifacts/playwright/runs/,
 * mirroring `renderRunReportHtml.ts`'s `toHref` but rooted at `SUITE_REVIEW_DIR` instead of
 * `REPORT_DIR` (imported only for the doc-comment cross-reference above, not reused directly,
 * since the two report kinds live in different subdirectories of artifacts/playwright/runs/). */
function toHref(repoRelativePath: string): string {
  return relative(SUITE_REVIEW_DIR, repoRelativePath).split(sep).join("/");
}

function renderCriterionRow(c: CriterionResultShape): string {
  return `<tr class="${c.needsHumanReview ? "criterion-needs-review" : ""}">
    <th scope="row">${esc(c.label)}</th>
    <td>${c.needsHumanReview ? "NEEDS HUMAN REVIEW" : `${c.points}/${c.weight}`}</td>
    <td>${esc(c.confidence)}</td>
    <td>${esc(c.rationale)}</td>
  </tr>`;
}

function renderScoreSection(title: string, score: ScoreResultShape): string {
  return `<h4>${esc(title)}: ${score.total}/100${score.band ? ` (band: ${esc(score.band)})` : ""} <span class="badge badge-${esc(score.source)}">${esc(score.source)}</span></h4>
  <p class="test-meta">Model version: ${esc(score.modelVersion)}</p>
  ${
    score.overrideRef
      ? `<p class="why"><strong>Human override:</strong> ${esc(score.overrideRef.rationale)} -- approved by ${esc(score.overrideRef.approver)} on ${esc(score.overrideRef.date)}</p>`
      : ""
  }
  <table class="meta criteria-table">
    <thead><tr><th scope="col">Criterion</th><th scope="col">Points</th><th scope="col">Confidence</th><th scope="col">Rationale</th></tr></thead>
    <tbody>${score.criteria.map(renderCriterionRow).join("")}</tbody>
  </table>`;
}

function riskTagOf(tags: string[]): string | undefined {
  return tags.find((t) => t.startsWith("@risk:"));
}
function featureTagsOf(tags: string[]): string[] {
  return tags.filter((t) => t.startsWith("@feature:"));
}
function resultStatusOf(test: SuiteReviewTestEntry): string {
  return test.lastKnownResult?.status ?? "never-executed";
}
function needsReview(test: SuiteReviewTestEntry): boolean {
  return test.valueScore.provisional || test.qualityScore.provisional;
}

/** Quality scores are never banded by the model itself (Section 8.4 only defines bands for value
 * scores) -- this bucketing exists only so the quality filter dropdown below has discrete options
 * to offer, matching the same edges `suite-review.ts` uses for the quality score distribution
 * histogram. Purely a display/filter grouping, never written back into the score itself. */
const QUALITY_FILTER_BANDS = [
  { label: "90-100", min: 90, max: 100 },
  { label: "75-89", min: 75, max: 89 },
  { label: "50-74", min: 50, max: 74 },
  { label: "25-49", min: 25, max: 49 },
  { label: "0-24", min: 0, max: 24 },
];
function qualityFilterBandOf(total: number): string {
  return QUALITY_FILTER_BANDS.find((b) => total >= b.min && total <= b.max)?.label ?? "0-24";
}

function renderTestDetail(test: SuiteReviewTestEntry): string {
  const sourceHref = toHref(test.filePath);
  const risk = riskTagOf(test.tags) ?? "(none)";
  const features = featureTagsOf(test.tags);
  const result = resultStatusOf(test);
  return `<details class="test-row"
    data-test-id="${esc(test.testId)}"
    data-quarantined="${test.quarantined}"
    data-needs-review="${needsReview(test)}"
    data-stale="${Boolean(test.lastKnownResult?.staleBeyondFreshnessWindow)}"
    data-never-executed="${!test.lastKnownResult}"
    data-risk="${esc(risk)}"
    data-features="${esc(features.join(" "))}"
    data-result="${esc(result)}"
    data-value-band="${esc(test.valueScore.band ?? "")}"
    data-quality-band="${esc(qualityFilterBandOf(test.qualityScore.total))}">
  <summary>
    <span class="badge ${test.quarantined ? "badge-quarantined" : needsReview(test) ? "badge-warn" : "badge-ok"}">
      ${test.quarantined ? "⚠ Quarantined" : needsReview(test) ? "◐ Needs review" : "✓ Evaluated"}
    </span>
    <span class="test-title">${esc(test.title)}</span>
    <span class="test-meta">value ${test.valueScore.total}/100 &middot; quality ${test.qualityScore.total}/100 &middot; ${esc(result)}</span>
  </summary>
  <div class="test-body">
    <p class="test-source"><a href="${esc(sourceHref)}">${esc(test.filePath)}:${test.line}</a> <code>${esc(test.filePath)}:${test.line}</code></p>
    <p class="test-id"><code>${esc(test.testId)}</code></p>
    <p><strong>Objective:</strong> ${esc(test.objective)}</p>
    <p><strong>Expected outcome:</strong> ${esc(test.expectedOutcome)}</p>
    ${test.requirementIds.length ? `<p><strong>Requirements:</strong> ${test.requirementIds.map(esc).join(", ")}</p>` : "<p><strong>Requirements:</strong> (none declared)</p>"}
    <p><strong>Tags:</strong> ${test.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</p>
    ${
      test.lastKnownResult
        ? `<p><strong>Last known result:</strong> ${esc(test.lastKnownResult.status)}, ${test.lastKnownResult.ageDays.toFixed(1)} day(s) ago (run ${esc(test.lastKnownResult.runId)})${test.lastKnownResult.staleBeyondFreshnessWindow ? " -- stale, outside the freshness window" : ""}</p>`
        : `<p><strong>Last known result:</strong> never executed</p>`
    }
    ${renderScoreSection("Value score", test.valueScore)}
    ${renderScoreSection("Quality score", test.qualityScore)}
    ${
      test.recommendations.length
        ? `<h4>Recommendations requiring human review</h4><ul>${test.recommendations.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
        : ""
    }
  </div>
</details>`;
}

function renderDistribution(title: string, distribution: Record<string, number>): string {
  const entries = Object.entries(distribution);
  if (entries.length === 0) return `<h3>${esc(title)}</h3><p>No scored tests yet.</p>`;
  const max = Math.max(...entries.map(([, v]) => v), 1);
  return `<h3>${esc(title)}</h3>
  <div class="distribution" role="list">
    ${entries
      .map(
        ([bucket, count]) =>
          `<div class="dist-row" role="listitem"><span class="dist-label">${esc(bucket)}</span><span class="dist-bar" style="width:${(count / max) * 100}%"></span><span class="dist-count">${count}</span></div>`,
      )
      .join("")}
  </div>`;
}

export function renderSuiteReviewHtml(review: SuiteReview): string {
  const allFeatureTags = Array.from(
    new Set(review.tests.flatMap((t) => featureTagsOf(t.tags))),
  ).sort();
  const allRiskTags = Array.from(
    new Set(review.tests.map((t) => riskTagOf(t.tags)).filter((t): t is string => Boolean(t))),
  ).sort();
  const allResultStatuses = Array.from(new Set(review.tests.map(resultStatusOf))).sort();
  const allValueBands = Array.from(
    new Set(review.tests.map((t) => t.valueScore.band).filter((b): b is string => Boolean(b))),
  );
  const allQualityBands = Array.from(
    new Set(review.tests.map((t) => qualityFilterBandOf(t.qualityScore.total))),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Suite review ${esc(review.reviewId)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1a1a1a; --muted: #555; --border: #d0d0d0;
    --pass: #0a6e31; --fail: #a3231b; --warn: #8a5a00; --card-bg: #f4f4f4; --bar: #6b8fce;
  }
  @media (prefers-color-scheme: dark) {
    /* Mirrors renderRunReportHtml.ts's dark-mode contrast rationale: light-mode --pass/--fail/--warn
       are tuned against a white background and fall under WCAG AA 4.5:1 on a dark one, so they are
       redefined here too, each independently verified against both --bg and --card-bg. */
    :root {
      --bg: #14161a; --fg: #e8e8e8; --muted: #aaa; --border: #3a3d42; --card-bg: #1f2227; --bar: #8fb0e6;
      --pass: #34d399; --fail: #f87171; --warn: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; margin: 0; padding: 1rem 1.25rem 3rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
  h3, h4 { font-size: 1rem; }
  a { color: inherit; }
  code, pre { font-family: ui-monospace, monospace; font-size: 0.85em; }
  table.meta { border-collapse: collapse; }
  table.meta th { text-align: left; padding: 0.15rem 0.75rem 0.15rem 0; color: var(--muted); font-weight: 600; vertical-align: top; }
  table.meta td { padding: 0.15rem 0; }
  table.criteria-table { width: 100%; border-collapse: collapse; margin: 0.4rem 0 1rem; }
  table.criteria-table th, table.criteria-table td { border: 1px solid var(--border); padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; font-size: 0.9rem; }
  tr.criterion-needs-review { background: var(--card-bg); }
  .badge { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); font-size: 0.8rem; font-weight: 600; white-space: nowrap; }
  .badge-ok { color: var(--pass); }
  .badge-warn { color: var(--warn); }
  .badge-quarantined { color: var(--warn); }
  .badge-calculated { color: var(--pass); }
  .badge-provisional { color: var(--warn); }
  .badge-override { color: var(--bar); }
  .tag { display: inline-block; border: 1px solid var(--border); border-radius: 4px; padding: 0 0.35rem; font-size: 0.8rem; margin: 0 0.15rem 0.15rem 0; }
  .filters { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; margin: 0.75rem 0 1rem; }
  .filters input[type="search"] { padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--fg); min-width: 16rem; }
  .filters label { display: inline-flex; align-items: center; gap: 0.3rem; }
  .filters select { padding: 0.3rem 0.4rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--fg); }
  .test-row { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 0.5rem; padding: 0; overflow: hidden; }
  .test-row summary { cursor: pointer; padding: 0.6rem 0.8rem; display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; list-style: none; }
  .test-row summary::-webkit-details-marker { display: none; }
  .test-row summary:focus-visible { outline: 2px solid; outline-offset: 2px; }
  .test-title { font-weight: 600; }
  .test-meta { color: var(--muted); font-size: 0.85rem; }
  .test-body { padding: 0.75rem 1rem 1rem; border-top: 1px solid var(--border); }
  .why { background: var(--card-bg); border-left: 3px solid var(--border); padding: 0.4rem 0.6rem; border-radius: 0 4px 4px 0; }
  .distribution { display: flex; flex-direction: column; gap: 0.3rem; max-width: 40rem; }
  .dist-row { display: grid; grid-template-columns: 8rem 1fr 2.5rem; align-items: center; gap: 0.5rem; }
  .dist-bar { background: var(--bar); height: 0.9rem; border-radius: 3px; min-width: 2px; }
  .dist-label { font-size: 0.85rem; color: var(--muted); }
  .dist-count { text-align: right; font-size: 0.85rem; }
  .queue-item { border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.8rem; margin-bottom: 0.4rem; }
  .queue-priority { font-weight: 700; margin-right: 0.5rem; }
  ol.queue-reasons { margin: 0.3rem 0 0; padding-left: 1.2rem; }
  [hidden] { display: none !important; }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Suite review</h1>
<table class="meta">
  <tbody>
    <tr><th scope="row">Review ID</th><td><code>${esc(review.reviewId)}</code></td></tr>
    <tr><th scope="row">Generated</th><td>${esc(review.generatedAt)}</td></tr>
    <tr><th scope="row">Framework version</th><td>${esc(review.frameworkVersion)}</td></tr>
    <tr><th scope="row">Value/quality model version</th><td>${esc(review.valueModelVersion)}</td></tr>
    <tr><th scope="row">Git commit</th><td><code>${esc(review.gitCommit)}</code>${review.workingTreeClean ? "" : " (working tree had uncommitted changes at review time)"}</td></tr>
    <tr><th scope="row">Freshness window</th><td>${review.freshnessWindowDays} day(s)</td></tr>
    <tr><th scope="row">Discovery parse errors</th><td>${review.parseErrorCount}${review.parseErrorCount > 0 ? " -- some test files could not be statically read; the tests they contain are NOT reflected below" : ""}</td></tr>
  </tbody>
</table>

<h2>Coverage</h2>
<table class="meta">
  <tbody>
    <tr><th scope="row">Requirement coverage</th><td>${review.requirementCoverage.covered}/${review.requirementCoverage.total} (${pct(review.requirementCoverage.covered, review.requirementCoverage.total)}) -- ${esc(review.requirementCoverage.denominatorLabel)}</td></tr>
    <tr><th scope="row">Risk-weighted coverage</th><td>${review.riskWeightedCoverage.covered}/${review.riskWeightedCoverage.total} (${pct(review.riskWeightedCoverage.covered, review.riskWeightedCoverage.total)}) -- ${esc(review.riskWeightedCoverage.weightingRule)}</td></tr>
  </tbody>
</table>

<h3>Requirements covered only by unhealthy tests, or not covered at all</h3>
<table class="meta criteria-table">
  <thead><tr><th scope="col">Requirement</th><th scope="col">Status</th><th scope="col">Covering test(s)</th><th scope="col">Flag</th></tr></thead>
  <tbody>
    ${review.requirementDetails
      .filter((r) => r.coveringTestIds.length === 0 || r.coveredOnlyByUnhealthyTests)
      .map(
        (r) => `<tr>
          <th scope="row">${esc(r.requirementId)} -- ${esc(r.title)}</th>
          <td>${esc(r.status)}</td>
          <td>${r.coveringTestIds.length ? r.coveringTestIds.map(esc).join(", ") : "(none)"}</td>
          <td>${r.coveringTestIds.length === 0 ? "UNCOVERED" : "covered only by unhealthy test(s)"}</td>
        </tr>`,
      )
      .join("") || `<tr><td colspan="4">Every eligible requirement is covered by at least one healthy test.</td></tr>`}
  </tbody>
</table>

<h3>Dimension coverage</h3>
${review.dimensionCoverage
  .map(
    (d) => `<h4>${esc(d.dimension)}</h4><p>${Object.entries(d.countsByTag)
      .map(([tag, count]) => `<span class="tag">${esc(tag)}: ${count}</span>`)
      .join(" ")}</p>`,
  )
  .join("")}

<h2>Duplicate or substantially overlapping tests</h2>
${
  review.duplicateCandidates.length === 0
    ? "<p>No duplicate candidates found.</p>"
    : `<table class="meta criteria-table">
      <thead><tr><th scope="col">Tests</th><th scope="col">Shared requirement(s)</th><th scope="col">Similarity</th><th scope="col">Rationale</th></tr></thead>
      <tbody>
        ${review.duplicateCandidates
          .map(
            (d) => `<tr>
              <td>${d.testIds.map(esc).join(", ")}</td>
              <td>${d.sharedRequirementIds.map(esc).join(", ")}</td>
              <td>${(d.objectiveSimilarity * 100).toFixed(0)}%</td>
              <td>${esc(d.rationale)}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>`
}
<p class="why">These are recommendations for human review, never automatic deletions.</p>

<h2>Score distributions</h2>
${renderDistribution("Value score bands", review.valueScoreDistribution)}
${renderDistribution("Quality score bands", review.qualityScoreDistribution)}

<h2>Prioritized review queue</h2>
${
  review.reviewQueue.length === 0
    ? "<p>Nothing currently needs human review.</p>"
    : review.reviewQueue
        .map(
          (item) => `<div class="queue-item">
            <span class="queue-priority">Priority ${item.priority}</span>
            <code>${esc(item.testId)}</code>
            <ol class="queue-reasons">${item.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>
          </div>`,
        )
        .join("")
}

${
  review.changesFromPreviousReview
    ? `<h2>Changes since the previous review</h2>
      <p>Compared against review <code>${esc(review.changesFromPreviousReview.previousReviewId)}</code> (generated ${esc(review.changesFromPreviousReview.previousGeneratedAt)}).</p>
      <p><strong>Added:</strong> ${review.changesFromPreviousReview.addedTestIds.length ? review.changesFromPreviousReview.addedTestIds.map(esc).join(", ") : "(none)"}</p>
      <p><strong>Removed:</strong> ${review.changesFromPreviousReview.removedTestIds.length ? review.changesFromPreviousReview.removedTestIds.map(esc).join(", ") : "(none)"}</p>
      <p><strong>Value score changes:</strong> ${review.changesFromPreviousReview.valueScoreChanges.length ? review.changesFromPreviousReview.valueScoreChanges.map((c) => `${esc(c.testId)}: ${c.previousTotal} &rarr; ${c.currentTotal}`).join(", ") : "(none)"}</p>
      <p><strong>Quality score changes:</strong> ${review.changesFromPreviousReview.qualityScoreChanges.length ? review.changesFromPreviousReview.qualityScoreChanges.map((c) => `${esc(c.testId)}: ${c.previousTotal} &rarr; ${c.currentTotal}`).join(", ") : "(none)"}</p>`
    : `<h2>Changes since the previous review</h2><p>No prior machine-readable suite review exists to compare against -- this is the first one.</p>`
}

<h2>Test catalog (${review.tests.length})</h2>
<div class="filters">
  <label for="search">Search</label>
  <input type="search" id="search" placeholder="Filter by title, ID, or tag">
  <label><input type="checkbox" id="filter-quarantined"> Quarantined only</label>
  <label><input type="checkbox" id="filter-needs-review"> Needs human review only</label>
  <label><input type="checkbox" id="filter-stale"> Stale or never-executed only</label>
  <label for="filter-risk">Risk</label>
  <select id="filter-risk"><option value="">All</option>${allRiskTags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}</select>
  <label for="filter-feature">Feature</label>
  <select id="filter-feature"><option value="">All</option>${allFeatureTags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}</select>
  <label for="filter-result">Result</label>
  <select id="filter-result"><option value="">All</option>${allResultStatuses.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select>
  <label for="filter-value-band">Value band</label>
  <select id="filter-value-band"><option value="">All</option>${allValueBands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("")}</select>
  <label for="filter-quality-band">Quality band</label>
  <select id="filter-quality-band"><option value="">All</option>${allQualityBands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("")}</select>
</div>
<div id="test-list">
${review.tests
  .slice()
  .sort((a, b) => a.testId.localeCompare(b.testId))
  .map(renderTestDetail)
  .join("\n")}
</div>
${review.tests.length === 0 ? '<p role="status">No tests were discovered.</p>' : ""}

<footer>
  <p>Generated by the Seatwise Playwright Quality Engineering Framework (Stage 07). Value/quality
  criteria marked NEEDS HUMAN REVIEW contribute zero to their score's total and are never invented
  -- see quality/test-value-model.md Section 8.6.</p>
</footer>

<script>
(function () {
  var search = document.getElementById("search");
  var qOnly = document.getElementById("filter-quarantined");
  var reviewOnly = document.getElementById("filter-needs-review");
  var staleOnly = document.getElementById("filter-stale");
  var riskSelect = document.getElementById("filter-risk");
  var featureSelect = document.getElementById("filter-feature");
  var resultSelect = document.getElementById("filter-result");
  var valueBandSelect = document.getElementById("filter-value-band");
  var qualityBandSelect = document.getElementById("filter-quality-band");
  var rows = Array.prototype.slice.call(document.querySelectorAll(".test-row"));

  function applyFilters() {
    var q = (search.value || "").toLowerCase();
    var risk = riskSelect.value;
    var feature = featureSelect.value;
    var result = resultSelect.value;
    var valueBand = valueBandSelect.value;
    var qualityBand = qualityBandSelect.value;
    rows.forEach(function (row) {
      var visible = true;
      if (q.length > 0 && row.textContent.toLowerCase().indexOf(q) === -1) visible = false;
      if (qOnly.checked && row.dataset.quarantined !== "true") visible = false;
      if (reviewOnly.checked && row.dataset.needsReview !== "true") visible = false;
      if (staleOnly.checked && row.dataset.stale !== "true" && row.dataset.neverExecuted !== "true") visible = false;
      if (risk && row.dataset.risk !== risk) visible = false;
      if (feature && (" " + row.dataset.features + " ").indexOf(" " + feature + " ") === -1) visible = false;
      if (result && row.dataset.result !== result) visible = false;
      if (valueBand && row.dataset.valueBand !== valueBand) visible = false;
      if (qualityBand && row.dataset.qualityBand !== qualityBand) visible = false;
      row.hidden = !visible;
    });
  }

  [search, qOnly, reviewOnly, staleOnly, riskSelect, featureSelect, resultSelect, valueBandSelect, qualityBandSelect].forEach(function (el) {
    el.addEventListener("input", applyFilters);
    el.addEventListener("change", applyFilters);
  });
})();
</script>
</body>
</html>
`;
}
