/**
 * Stage 06 — renders a validated `RunReport` (playwright-framework/metadata/schemas.ts) into a
 * single, self-contained HTML file: no external stylesheets, scripts, fonts, or network requests
 * of any kind (spec Section 10.1: "self-contained and viewable offline"). All filtering/sorting is
 * plain vanilla JS operating on the DOM already rendered server-side -- there is no client-side
 * re-fetch of anything, so the report keeps working if opened straight from disk with no server.
 *
 * Every dynamic string is HTML-escaped before insertion (`esc`) -- test titles, tags, and error
 * text can all contain characters an attacker (or just an unlucky test name) chose, and this is
 * the one place that content becomes literal HTML.
 *
 * Accessibility (Section 10.1): a single semantic heading hierarchy (h1 run title, h2 per section,
 * h3 per test), a real `<table>` with `<th scope="col">` for the test list, `<details>/<summary>`
 * for per-test expansion (native keyboard support, no custom JS focus management needed), status
 * conveyed by a text word AND a symbol together (never color alone), and filter controls that are
 * real `<input>`/`<button>` elements reachable by Tab.
 */

import { relative, sep } from "node:path";
import type { RunReport, RunReportTest, StepOutcome } from "../metadata/schemas.js";
import { REPORT_DIR } from "./constants.js";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A repo-root-relative path (as stored in the report JSON) turned into an href that actually
 * resolves from this HTML file's own location on disk (`REPORT_DIR`). */
function toHref(repoRelativePath: string): string {
  return relative(REPORT_DIR, repoRelativePath).split(sep).join("/");
}

interface StatusMeta {
  label: string;
  symbol: string;
  countKey: keyof RunReport["counts"];
}

const STATUS_META: Record<RunReportTest["status"], StatusMeta> = {
  "initial-pass": { label: "Passed", symbol: "✓", countKey: "initialPass" },
  "retry-pass": { label: "Passed on retry (flaky)", symbol: "↻", countKey: "retryPass" },
  "consistent-failure": { label: "Failed", symbol: "✗", countKey: "consistentFailure" },
  timeout: { label: "Timed out", symbol: "⏱", countKey: "timeout" },
  skipped: { label: "Skipped", symbol: "⏭", countKey: "skipped" },
  "expected-failure": { label: "Failed as expected", symbol: "✓*", countKey: "expectedFailure" },
  quarantined: { label: "Quarantined", symbol: "⚠", countKey: "quarantined" },
  "setup-failure": { label: "Setup/infrastructure failure", symbol: "⚙✗", countKey: "setupFailure" },
};

function renderStep(step: StepOutcome): string {
  const statusWord = step.status === "failed" ? "FAILED" : step.status === "skipped" ? "SKIPPED" : "OK";
  return `<li class="step step-${esc(step.status)}">
    <span class="step-status" aria-hidden="true">${step.status === "failed" ? "✗" : "✓"}</span>
    <span class="step-title">${esc(step.title)}</span>
    <span class="step-meta">[${esc(statusWord)}, ${step.durationMs}ms]</span>
    ${step.error ? `<pre class="step-error">${esc(step.error)}</pre>` : ""}
  </li>`;
}

function renderTestDetail(test: RunReportTest): string {
  const meta = STATUS_META[test.status];
  const sourceHref = toHref(test.filePath);
  return `<details class="test-row" data-status="${esc(test.status)}" data-test-id="${esc(test.testId)}">
  <summary>
    <span class="badge badge-${esc(test.status)}"><span aria-hidden="true">${meta.symbol}</span> ${esc(meta.label)}</span>
    <span class="test-title">${esc(test.title)}</span>
    <span class="test-meta">${test.durationMs}ms &middot; ${test.attempts} attempt(s) &middot; ${test.assertionCount} assertion(s)</span>
  </summary>
  <div class="test-body">
    <p class="test-source"><a href="${esc(sourceHref)}">${esc(test.filePath)}:${test.line}</a></p>
    <p class="test-id"><code>${esc(test.testId)}</code></p>
    ${test.objective ? `<p><strong>Objective:</strong> ${esc(test.objective)}</p>` : ""}
    ${test.expectedOutcome ? `<p><strong>Expected outcome:</strong> ${esc(test.expectedOutcome)}</p>` : ""}
    ${test.requirementIds.length ? `<p><strong>Requirements:</strong> ${test.requirementIds.map(esc).join(", ")}</p>` : ""}
    <p><strong>Tags:</strong> ${test.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</p>
    ${test.whyPassed ? `<p class="why why-passed"><strong>Why this passed:</strong> ${esc(test.whyPassed)}</p>` : ""}
    ${test.whyFailed ? `<p class="why why-failed"><strong>Why this failed:</strong> ${esc(test.whyFailed)}</p>` : ""}
    ${
      test.errorMessage
        ? `<p class="error-message"><strong>Error:</strong> ${esc(test.errorMessage)}</p>`
        : ""
    }
    ${
      test.sanitizedStackTrace
        ? `<details class="stack-trace-details"><summary>Stack trace</summary><pre>${esc(test.sanitizedStackTrace)}</pre></details>`
        : ""
    }
    ${
      test.steps.length
        ? `<h4>Steps</h4><ol class="steps">${test.steps.map(renderStep).join("")}</ol>`
        : ""
    }
    ${
      test.successCheckpoints.length
        ? `<h4>Success checkpoints</h4><ul class="checkpoints">${test.successCheckpoints
            .map(
              (c) => `<li><strong>${esc(c.name)}:</strong> ${esc(c.validationDescription)}${
                c.screenshotPath
                  ? ` <a href="${esc(toHref(c.screenshotPath))}">screenshot</a>`
                  : " (no screenshot on file)"
              }</li>`,
            )
            .join("")}</ul>`
        : ""
    }
    ${
      test.failureScreenshotPath || test.tracePath || test.videoPath
        ? `<h4>Failure diagnostics</h4><ul class="diagnostics-links">
            ${test.failureScreenshotPath ? `<li><a href="${esc(toHref(test.failureScreenshotPath))}">Failure screenshot</a></li>` : ""}
            ${test.tracePath ? `<li><a href="${esc(toHref(test.tracePath))}">Trace (open with Trace Viewer)</a></li>` : ""}
            ${test.videoPath ? `<li><a href="${esc(toHref(test.videoPath))}">Video</a></li>` : ""}
          </ul>`
        : ""
    }
    ${
      test.consoleMessages
        ? `<details><summary>Console messages</summary><pre>${esc(test.consoleMessages)}</pre></details>`
        : ""
    }
    ${
      test.failedNetworkRequests
        ? `<details><summary>Failed network requests</summary><pre>${esc(test.failedNetworkRequests)}</pre></details>`
        : ""
    }
  </div>
</details>`;
}

function renderSummaryCards(counts: RunReport["counts"]): string {
  const order: RunReportTest["status"][] = [
    "initial-pass",
    "retry-pass",
    "consistent-failure",
    "timeout",
    "skipped",
    "expected-failure",
    "quarantined",
    "setup-failure",
  ];
  return `<div class="summary-cards" role="list">
    ${order
      .map((status) => {
        const meta = STATUS_META[status];
        const value = counts[meta.countKey];
        return `<div class="summary-card" role="listitem">
          <span class="summary-symbol" aria-hidden="true">${meta.symbol}</span>
          <span class="summary-count">${value}</span>
          <span class="summary-label">${esc(meta.label)}</span>
        </div>`;
      })
      .join("")}
  </div>`;
}

export function renderRunReportHtml(report: RunReport): string {
  const generatedTitle = `Run report ${esc(report.runId)}`;
  const totalRan = report.tests.length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${generatedTitle}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1a1a1a; --muted: #555; --border: #d0d0d0;
    --pass: #0a6e31; --fail: #a3231b; --warn: #8a5a00; --card-bg: #f4f4f4;
  }
  @media (prefers-color-scheme: dark) {
    /* Status colors (--pass/--fail/--warn) are redefined here too, not just bg/fg/border: the
       light-mode values (#0a6e31/#a3231b/#8a5a00) are dark, low-luminance colors chosen for
       contrast against a WHITE background -- against this dark background they fall to roughly
       2.4-3.1:1 contrast, well under WCAG AA's 4.5:1 minimum for normal-size text (Section 10.1:
       "sufficient contrast"), even though the badge/status text is never large enough to qualify
       for the lower 3:1 "large text" threshold. Measured against both --bg and --card-bg (the
       summary cards and .why boxes sit on the card background, not the page background): every
       color below clears 4.5:1 against both. */
    :root {
      --bg: #14161a; --fg: #e8e8e8; --muted: #aaa; --border: #3a3d42; --card-bg: #1f2227;
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
  pre { white-space: pre-wrap; word-break: break-word; background: var(--card-bg); padding: 0.5rem; border-radius: 4px; border: 1px solid var(--border); }
  table.meta { border-collapse: collapse; }
  table.meta th { text-align: left; padding: 0.15rem 0.75rem 0.15rem 0; color: var(--muted); font-weight: 600; vertical-align: top; }
  table.meta td { padding: 0.15rem 0; }
  .summary-cards { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .summary-card { border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.9rem; min-width: 9rem; background: var(--card-bg); display: flex; flex-direction: column; align-items: flex-start; }
  .summary-symbol { font-size: 1.1rem; }
  .summary-count { font-size: 1.4rem; font-weight: 700; }
  .summary-label { color: var(--muted); font-size: 0.85rem; }
  .filters { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; margin: 0.75rem 0 1rem; }
  .filters input[type="search"] { padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--fg); min-width: 16rem; }
  .filters label { display: inline-flex; align-items: center; gap: 0.3rem; }
  .test-row { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 0.5rem; padding: 0; overflow: hidden; }
  .test-row summary { cursor: pointer; padding: 0.6rem 0.8rem; display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; list-style: none; }
  .test-row summary::-webkit-details-marker { display: none; }
  .test-row summary:focus-visible { outline: 2px solid; outline-offset: 2px; }
  .test-title { font-weight: 600; }
  .test-meta { color: var(--muted); font-size: 0.85rem; }
  .test-body { padding: 0.75rem 1rem 1rem; border-top: 1px solid var(--border); }
  .badge { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); font-size: 0.8rem; font-weight: 600; white-space: nowrap; }
  .badge-initial-pass, .badge-retry-pass, .badge-expected-failure { color: var(--pass); }
  .badge-consistent-failure, .badge-timeout, .badge-setup-failure { color: var(--fail); }
  .badge-skipped, .badge-quarantined { color: var(--warn); }
  .tag { display: inline-block; border: 1px solid var(--border); border-radius: 4px; padding: 0 0.35rem; font-size: 0.8rem; margin: 0 0.15rem 0.15rem 0; }
  .steps { padding-left: 1.2rem; }
  .step { margin-bottom: 0.35rem; }
  .step-status { margin-right: 0.3rem; }
  .step-error { margin: 0.3rem 0 0; }
  .why { background: var(--card-bg); border-left: 3px solid var(--border); padding: 0.4rem 0.6rem; border-radius: 0 4px 4px 0; }
  [hidden] { display: none !important; }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Test run report</h1>
<table class="meta">
  <tbody>
    <tr><th scope="row">Run ID</th><td><code>${esc(report.runId)}</code></td></tr>
    <tr><th scope="row">Started</th><td>${esc(report.startedAt)}</td></tr>
    <tr><th scope="row">Ended</th><td>${esc(report.endedAt)} (${report.durationMs}ms)</td></tr>
    <tr><th scope="row">Initiator</th><td>${esc(report.initiator)}</td></tr>
    <tr><th scope="row">Environment</th><td>${esc(report.environment)}</td></tr>
    <tr><th scope="row">Base URL</th><td>${esc(report.baseUrl)}</td></tr>
    <tr><th scope="row">Git commit</th><td><code>${esc(report.gitCommit)}</code>${report.workingTreeClean ? "" : " (working tree had uncommitted changes at run time)"}</td></tr>
    <tr><th scope="row">Playwright / Node / OS</th><td>${esc(report.playwrightVersion)} / ${esc(report.nodeVersion)} / ${esc(report.operatingSystem)}</td></tr>
    <tr><th scope="row">Browser project(s)</th><td>${report.browserProjects.map(esc).join(", ")}</td></tr>
    <tr><th scope="row">Workers / retries</th><td>${report.workers} / ${report.retries}</td></tr>
    <tr><th scope="row">Tag expression</th><td>${report.tagExpression ? `<code>${esc(report.tagExpression)}</code>` : "(none -- ran without pw:run's selection)"}</td></tr>
    <tr><th scope="row">Selection</th><td>${report.selectionSummary.matchedCount} matched, ${report.selectionSummary.excludedCount} excluded by the filter</td></tr>
    <tr><th scope="row">Generated</th><td>${esc(report.generatedAt)}</td></tr>
    ${report.nativeReportPath ? `<tr><th scope="row">Native report</th><td><a href="${esc(report.nativeReportPath)}">Playwright HTML report</a></td></tr>` : ""}
  </tbody>
</table>

<h2>Summary</h2>
${renderSummaryCards(report.counts)}

<h2>Tests (${totalRan})</h2>
<div class="filters">
  <label for="search">Search</label>
  <input type="search" id="search" placeholder="Filter by title, ID, or tag" aria-describedby="search-help">
  <span id="search-help" class="test-meta">Matches title, test ID, and tags</span>
  <label><input type="checkbox" class="status-filter" value="all" checked> All statuses</label>
</div>
<div id="test-list">
${report.tests
  .sort((a, b) => a.testId.localeCompare(b.testId))
  .map(renderTestDetail)
  .join("\n")}
</div>
${totalRan === 0 ? '<p role="status">No tests were executed in this run.</p>' : ""}

<footer>
  <p>Generated by the Seatwise Playwright Quality Engineering Framework (Stage 06). This report contains no AI-generated judgment -- every explanation above is derived deterministically from Playwright's own recorded step and assertion data, not inferred.</p>
</footer>

<script>
(function () {
  var search = document.getElementById("search");
  var rows = Array.prototype.slice.call(document.querySelectorAll(".test-row"));
  function applyFilter() {
    var q = (search.value || "").toLowerCase();
    rows.forEach(function (row) {
      var text = row.textContent.toLowerCase();
      row.hidden = q.length > 0 && text.indexOf(q) === -1;
    });
  }
  search.addEventListener("input", applyFilter);
})();
</script>
</body>
</html>
`;
}
