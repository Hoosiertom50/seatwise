#!/usr/bin/env node
/**
 * Stage 09 — serves artifacts/playwright/ so a generated maintenance report's relative links
 * (source file hrefs, and links back to the run report/screenshots/traces it triaged) resolve
 * correctly, mirroring Stage 07's serve-suite-review.ts (itself fixing the exact "how many `..`
 * segments can a served, one-directory-deep page's URL actually resolve" bug this reuses the fix
 * for -- see playwright-framework/reporting/servedPath.ts's own doc comment for the full story).
 *
 * ROOT here is `artifacts/playwright` (one level above both `maintenance/` and `runs/`), not just
 * `artifacts/playwright/runs` as serve-suite-review.ts uses -- a maintenance report is served at
 * `/maintenance/<reportId>.html` (also one directory level deep) and its own evidence links point
 * at sibling directories under `artifacts/playwright/` (`runs/run-reports/...`), so both reports'
 * and this one's attachments need to live under the SAME served root for their relative `../`
 * links to resolve to the right place.
 *
 * Usage:
 *   pnpm pw:triage:serve                serve the most recently generated maintenance report
 *   pnpm pw:triage:serve <reportId>     serve a specific maintenance report by its report ID
 */
import { createServer } from "node:http";
import { readdirSync, statSync, createReadStream, existsSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { candidatePathsForRequest } from "../reporting/servedPath.js";

const REPO_ROOT = resolve(process.cwd());
const ROOT = resolve(REPO_ROOT, "artifacts/playwright");
const MAINTENANCE_DIR = join(ROOT, "maintenance");
const PORT = Number(process.env.PW_TRIAGE_PORT) || 4302;

const ALLOWED_SOURCE_DIRS = ["e2e", "playwright-framework"];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function findReportPath(requestedReportId: string | undefined): string {
  if (!existsSync(MAINTENANCE_DIR)) {
    console.error(`No maintenance reports found at artifacts/playwright/maintenance/ -- run \`pnpm pw:triage\` first.`);
    process.exit(1);
  }
  if (requestedReportId) {
    const path = join(MAINTENANCE_DIR, `${requestedReportId}.html`);
    if (!existsSync(path)) {
      console.error(`No maintenance report found for report ID "${requestedReportId}" (expected ${path}).`);
      process.exit(1);
    }
    return path;
  }
  const htmlFiles = readdirSync(MAINTENANCE_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({ f, mtime: statSync(join(MAINTENANCE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (htmlFiles.length === 0) {
    console.error(`No maintenance report HTML files found under artifacts/playwright/maintenance/.`);
    process.exit(1);
  }
  return join(MAINTENANCE_DIR, htmlFiles[0].f);
}

function main(): void {
  const requestedReportId = process.argv[2];
  const reportPath = findReportPath(requestedReportId);
  const relativeUrlPath = "/" + reportPath.slice(ROOT.length + 1).split(sep).join("/");

  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const candidates = candidatePathsForRequest(urlPath, {
      primaryRoot: ROOT,
      repoRoot: REPO_ROOT,
      allowedSecondaryDirs: ALLOWED_SOURCE_DIRS,
    });
    const filePath = candidates.find((p) => existsSync(p) && !statSync(p).isDirectory());
    if (!filePath) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const contentType = CONTENT_TYPES[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    createReadStream(filePath).pipe(res);
  });

  server.listen(PORT, () => {
    console.log(`Serving artifacts/playwright/ at http://localhost:${PORT}`);
    console.log(`Maintenance report: http://localhost:${PORT}${relativeUrlPath}`);
    console.log("Press Ctrl+C to stop.");
  });
}

main();
