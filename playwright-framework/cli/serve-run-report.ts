#!/usr/bin/env node
/**
 * Stage 06 — "Implement a local report-serving command" (spec task). Serves
 * `artifacts/playwright/runs/` as static files over plain HTTP so a generated run report's
 * relative links (the native Playwright HTML report, trace files, screenshots, videos) all
 * resolve correctly, exactly like `playwright show-report` already does for the native report
 * alone (`pnpm pw:report`/`pw:serve-report`). No new dependency: a small `node:http` static file
 * server, since a run report is just files on disk and does not need anything more.
 *
 * Usage:
 *   pnpm pw:report:run              serve the most recently generated run report
 *   pnpm pw:report:run <runId>      serve a specific run report by its run ID
 *
 * Never a network fetch, never an editor deep link (this framework has none configured -- Section
 * 5's Decision Log DEC-004): the server only ever reads files already on disk under
 * `artifacts/playwright/runs/`.
 */
import { createServer } from "node:http";
import { readdirSync, statSync, createReadStream, existsSync } from "node:fs";
import { extname, join, resolve, normalize, sep } from "node:path";

const ROOT = resolve(process.cwd(), "artifacts/playwright/runs");
const RUN_REPORTS_DIR = join(ROOT, "run-reports");
const PORT = Number(process.env.PW_REPORT_PORT) || 4300;

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

function findReportPath(requestedRunId: string | undefined): string {
  if (!existsSync(RUN_REPORTS_DIR)) {
    console.error(
      `No run reports found at artifacts/playwright/runs/run-reports/ -- run \`pnpm pw:run\` (or ` +
        `\`pnpm pw:test\`) at least once first.`,
    );
    process.exit(1);
  }
  if (requestedRunId) {
    const path = join(RUN_REPORTS_DIR, `${requestedRunId}.html`);
    if (!existsSync(path)) {
      console.error(`No run report found for run ID "${requestedRunId}" (expected ${path}).`);
      process.exit(1);
    }
    return path;
  }
  const htmlFiles = readdirSync(RUN_REPORTS_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({ f, mtime: statSync(join(RUN_REPORTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (htmlFiles.length === 0) {
    console.error(`No run report HTML files found under artifacts/playwright/runs/run-reports/.`);
    process.exit(1);
  }
  return join(RUN_REPORTS_DIR, htmlFiles[0].f);
}

function main(): void {
  const requestedRunId = process.argv[2];
  const reportPath = findReportPath(requestedRunId);
  const relativeUrlPath = "/" + reportPath.slice(ROOT.length + 1).split(sep).join("/");

  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(ROOT, safePath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const contentType = CONTENT_TYPES[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    createReadStream(filePath).pipe(res);
  });

  server.listen(PORT, () => {
    console.log(`Serving artifacts/playwright/runs/ at http://localhost:${PORT}`);
    console.log(`Run report: http://localhost:${PORT}${relativeUrlPath}`);
    console.log("Press Ctrl+C to stop.");
  });
}

main();
