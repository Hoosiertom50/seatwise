#!/usr/bin/env node
/**
 * Stage 07 — serves artifacts/playwright/runs/ so a generated suite-review HTML file's relative
 * links (source file hrefs, screenshot/trace links reused from run-report data) resolve correctly,
 * exactly like Stage 06's serve-run-report.ts does for run reports (pnpm pw:report:run). Kept as a
 * thin, separate sibling command rather than folded into serve-run-report.ts: the two report kinds
 * are found in different subdirectories and a user asking to view "the suite review" should not
 * need to know that both are served from the same root.
 *
 * Usage:
 *   pnpm pw:review:serve                serve the most recently generated suite review
 *   pnpm pw:review:serve <reviewId>      serve a specific suite review by its review ID
 */
import { createServer } from "node:http";
import { readdirSync, statSync, createReadStream, existsSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { candidatePathsForRequest } from "../reporting/servedPath.js";

const REPO_ROOT = resolve(process.cwd());
const ROOT = resolve(REPO_ROOT, "artifacts/playwright/runs");
const SUITE_REVIEWS_DIR = join(ROOT, "suite-reviews");
const PORT = Number(process.env.PW_REVIEW_PORT) || 4301;

// Stage 07 audit, Finding 2 (High, fixed): a suite-review's own source-file links are authored
// relative to the repo root (e.g. "e2e/tests/guest-viewing.spec.ts"), which lives well outside
// `ROOT` above -- so they must also be servable, but ONLY from these two directories, never the
// bare repo root (which holds .env and other files this local, unauthenticated server must never
// expose). See playwright-framework/reporting/servedPath.ts for the full rationale.
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

function findReviewPath(requestedReviewId: string | undefined): string {
  if (!existsSync(SUITE_REVIEWS_DIR)) {
    console.error(
      `No suite reviews found at artifacts/playwright/runs/suite-reviews/ -- run \`pnpm pw:review\` first.`,
    );
    process.exit(1);
  }
  if (requestedReviewId) {
    const path = join(SUITE_REVIEWS_DIR, `${requestedReviewId}.html`);
    if (!existsSync(path)) {
      console.error(`No suite review found for review ID "${requestedReviewId}" (expected ${path}).`);
      process.exit(1);
    }
    return path;
  }
  const htmlFiles = readdirSync(SUITE_REVIEWS_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({ f, mtime: statSync(join(SUITE_REVIEWS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (htmlFiles.length === 0) {
    console.error(`No suite review HTML files found under artifacts/playwright/runs/suite-reviews/.`);
    process.exit(1);
  }
  return join(SUITE_REVIEWS_DIR, htmlFiles[0].f);
}

function main(): void {
  const requestedReviewId = process.argv[2];
  const reviewPath = findReviewPath(requestedReviewId);
  const relativeUrlPath = "/" + reviewPath.slice(ROOT.length + 1).split(sep).join("/");

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
    console.log(`Serving artifacts/playwright/runs/ at http://localhost:${PORT}`);
    console.log(`Suite review: http://localhost:${PORT}${relativeUrlPath}`);
    console.log("Press Ctrl+C to stop.");
  });
}

main();
