/**
 * Stage 07 audit (Finding 2, High, fixed) — `serve-suite-review.ts`'s own doc comment claims it
 * "serves artifacts/playwright/runs/ so a generated suite-review HTML file's relative links
 * (source file hrefs, ...) resolve correctly". This was false for the one link that actually
 * matters most: a test's own source-file link. `renderSuiteReviewHtml.ts`'s `toHref` computes an
 * href relative to `artifacts/playwright/runs/suite-reviews` (3 directory levels below the repo
 * root) for a REPO-ROOT-relative path like `e2e/tests/guest-viewing.spec.ts` -- producing
 * `../../../../e2e/tests/guest-viewing.spec.ts` (4 `..` segments). A served suite-review page's own
 * URL is only 1 directory level deep (`/suite-reviews/<id>.html`), so a real browser's URL
 * resolution algorithm can only "use" 1 of those 4 `..` segments before it runs out of path to pop
 * and clamps at the server's own URL root -- landing on `/e2e/tests/guest-viewing.spec.ts`, NOT
 * some URL that reflects "4 directories up from where this page lives". The server's `ROOT` was
 * `artifacts/playwright/runs`, which has no `e2e/` subdirectory, so every source-file link 404'd.
 * Reproduced live in a real headless Chromium against a real served suite review (audit notes).
 *
 * The fix is NOT to widen the server's root to the whole repo (that would newly expose `.env` and
 * anything else at repo root through this unauthenticated local static file server) -- it is this
 * module's `candidatePathsForRequest`: a request is resolved first against the existing, narrow
 * `primaryRoot` (artifacts/playwright/runs, for the report's own JSON/HTML/screenshots/traces),
 * and, only if that misses, against the repo root BUT ONLY inside an explicit allowlist of
 * directories that can legitimately contain test source (`e2e/`, `playwright-framework/`) -- never
 * the bare repo root itself. Pure and side-effect-free (no filesystem access) so it can be unit
 * tested directly; the caller does the actual existsSync/isDirectory check on whichever candidate
 * comes back first.
 */

import { join, normalize, sep } from "node:path";

export interface ServedPathRoots {
  /** Every request is resolved against this root first (e.g. artifacts/playwright/runs). */
  primaryRoot: string;
  /** The repository root, used only as the base for `allowedSecondaryDirs` below -- never served
   * bare. */
  repoRoot: string;
  /** Repo-root-relative directory names that may be served as a fallback when a request doesn't
   * resolve under `primaryRoot` -- e.g. ["e2e", "playwright-framework"]. Keep this list to
   * directories that hold only test/framework source, never repo-root files like .env. */
  allowedSecondaryDirs: string[];
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Returns the candidate absolute filesystem paths a request could resolve to, in priority order.
 * `urlPath` is the raw, already-decoded request path (e.g. "/e2e/tests/guest-viewing.spec.ts").
 * Every candidate returned has already been checked to stay within its own allowed root -- the
 * caller only needs to check existence/directory-ness on whichever comes first.
 */
export function candidatePathsForRequest(urlPath: string, roots: ServedPathRoots): string[] {
  // `normalize` collapses any internal ".." against an absolute ("/...") path down to root (it can
  // never walk above "/"), and the leading-".." strip is a second, redundant belt for anything
  // normalize somehow left -- matches the traversal defense `serve-run-report.ts` already relies on
  // (Stage 06 audit: confirmed live that a `../../../etc/passwd`-style attempt never escapes root).
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");

  const candidates: string[] = [];

  const underPrimary = join(roots.primaryRoot, safePath);
  if (isWithin(underPrimary, roots.primaryRoot)) {
    candidates.push(underPrimary);
  }

  const underRepo = join(roots.repoRoot, safePath);
  const allowed = roots.allowedSecondaryDirs.some((dir) => isWithin(underRepo, join(roots.repoRoot, dir)));
  if (allowed) {
    candidates.push(underRepo);
  }

  return candidates;
}
