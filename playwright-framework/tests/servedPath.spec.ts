import { test, expect } from "@playwright/test";
import { resolve, sep } from "node:path";
import { candidatePathsForRequest } from "../reporting/servedPath.js";

// Stage 07 audit, Finding 2 (High): serve-suite-review.ts served only artifacts/playwright/runs/,
// but renderSuiteReviewHtml.ts's source-file hrefs are authored relative to that directory for a
// repo-root-relative path (e.g. "../../../../e2e/tests/guest-viewing.spec.ts") -- a real browser's
// URL resolution can only pop 1 real directory level off a served page's own shallow URL
// (/suite-reviews/<id>.html) before clamping at the server's URL root, landing on
// "/e2e/tests/guest-viewing.spec.ts", which the old server had no way to serve. Reproduced live in
// a real headless Chromium against a real served suite review before this fix (audit notes).

const REPO_ROOT = resolve("/repo");
const PRIMARY_ROOT = resolve(REPO_ROOT, "artifacts/playwright/runs");
const ROOTS = { primaryRoot: PRIMARY_ROOT, repoRoot: REPO_ROOT, allowedSecondaryDirs: ["e2e", "playwright-framework"] };

test.describe("candidatePathsForRequest", () => {
  test("a report file under the primary root resolves there first", () => {
    const candidates = candidatePathsForRequest("/suite-reviews/abc.html", ROOTS);
    expect(candidates[0]).toBe(resolve(PRIMARY_ROOT, "suite-reviews/abc.html"));
  });

  test("the exact 4-'..'-segment source href a real suite review renders resolves under the allowed e2e/ directory (the bug this locks)", () => {
    // This is not a synthetic shape -- it's the literal href renderSuiteReviewHtml.ts produces:
    // relative(artifacts/playwright/runs/suite-reviews, e2e/tests/guest-viewing.spec.ts). A real
    // browser collapses this down to "/e2e/tests/guest-viewing.spec.ts" once served from
    // /suite-reviews/<id>.html (verified live against a real served page in this audit).
    const candidates = candidatePathsForRequest("/e2e/tests/guest-viewing.spec.ts", ROOTS);
    expect(candidates).toContain(resolve(REPO_ROOT, "e2e/tests/guest-viewing.spec.ts"));
  });

  test("a playwright-framework source path (e.g. defineQualityTest.ts) also resolves via the allowlist", () => {
    const candidates = candidatePathsForRequest("/playwright-framework/metadata/defineQualityTest.ts", ROOTS);
    expect(candidates).toContain(resolve(REPO_ROOT, "playwright-framework/metadata/defineQualityTest.ts"));
  });

  test("a repo-root file NOT in the allowlist (.env) is never offered as a candidate", () => {
    const candidates = candidatePathsForRequest("/.env", ROOTS);
    for (const c of candidates) {
      expect(c).not.toBe(resolve(REPO_ROOT, ".env"));
    }
  });

  test("a directory-traversal attempt aimed at the real /etc/passwd never resolves to it -- every candidate stays confined under an allowed root (matches Stage 06's own traversal-defense posture: 404, not a leaked file)", () => {
    const candidates = candidatePathsForRequest("/../../../../../../etc/passwd", ROOTS);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c).not.toBe("/etc/passwd"); // never the real, absolute system file
      const confined =
        c.startsWith(PRIMARY_ROOT + sep) ||
        c === PRIMARY_ROOT ||
        ROOTS.allowedSecondaryDirs.some((d) => c.startsWith(resolve(REPO_ROOT, d) + sep));
      expect(confined).toBe(true); // always a (nonexistent) subpath of an allowed root, never outside it
    }
  });

  test("every candidate returned is a real, resolvable absolute path (never a bare unresolved '..')", () => {
    const candidates = candidatePathsForRequest("/e2e/tests/guest-management.spec.ts", ROOTS);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c).not.toContain("..");
    }
  });
});
