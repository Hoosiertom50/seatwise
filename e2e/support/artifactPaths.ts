/**
 * Stage 03 — collision-safe artifact paths (spec Section 7.4 / Stage 03 task: "Ensure artifact
 * paths are unique across projects, workers, retries, and test IDs").
 *
 * Deliberately does not reimplement uniqueness itself: Playwright's own `TestInfo.outputPath()`
 * already derives a per-test, per-project, per-retry directory (`test-results/<project>-<test
 * file+title, slugified>-retry<N>/`), so two different tests, two different projects, or two
 * attempts of the same test after a retry can never collide -- and since Playwright never runs
 * the same test concurrently in two workers, worker-safety falls out of test-safety for free.
 * This module's only job is to turn a human-chosen checkpoint/diagnostic name into a filesystem-
 * safe filename and hand it to that existing guarantee, rather than inventing a second path
 * scheme that could drift out of sync with Playwright's.
 */

import type { TestInfo } from "@playwright/test";

/** Filesystem-safe slug: keeps the name recognizable while removing characters that could break a
 * path or collide with a reserved character on any of Playwright's supported platforms. */
export function slugifyArtifactName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Builds a collision-safe path for an artifact named `name` (e.g. "guest-added.png") under the
 * current test's own output directory. */
export function artifactPath(testInfo: TestInfo, name: string, extension: string): string {
  const slug = slugifyArtifactName(name);
  if (!slug) {
    throw new Error(`artifactPath: "${name}" produced an empty slug — choose a more descriptive name`);
  }
  return testInfo.outputPath(`${slug}.${extension.replace(/^\./, "")}`);
}
