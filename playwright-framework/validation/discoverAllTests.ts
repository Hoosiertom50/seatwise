/**
 * Stage 06 — small shared helper factored out of the discovery walk that
 * playwright-framework/cli/{lint-tests,run-tests}.ts each already do inline (find every real
 * `e2e/tests/**\/*.spec.ts` file, excluding `unit/`, and statically discover its
 * `defineQualityTest(...)` metadata). The reporter (playwright-framework/reporting/
 * normalizedReporter.ts) needs the exact same "how many tagged application tests exist in total"
 * count to compute Section 10.2's "selection summary ... tests excluded by the filter", so this
 * pulls the walk into one place rather than adding a third inline copy.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoverTestMetadataFromSource } from "./discoverTestMetadata.js";
import type { TestMetadata } from "../metadata/schemas.js";

const EXCLUDED_DIRS = new Set(["unit"]); // framework-support unit tests carry no quality tags

export interface DiscoveredApplicationTest {
  metadata: TestMetadata;
  filePath: string;
  line: number;
}

export function findApplicationSpecFiles(e2eTestsDir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(e2eTestsDir)) {
    const fullPath = join(e2eTestsDir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      results.push(...findApplicationSpecFiles(fullPath));
    } else if (entry.endsWith(".spec.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Statically discovers every real, tagged `defineQualityTest(...)` in `e2eTestsDir`. Returns
 * `parseErrorCount` alongside the tests found so a caller can decide how to treat files whose
 * metadata couldn't be statically read, rather than silently under-counting them. */
export function discoverAllApplicationTests(e2eTestsDir: string): {
  tests: DiscoveredApplicationTest[];
  parseErrorCount: number;
} {
  const specFiles = findApplicationSpecFiles(e2eTestsDir).sort();
  const tests: DiscoveredApplicationTest[] = [];
  let parseErrorCount = 0;

  for (const filePath of specFiles) {
    const source = readFileSync(filePath, "utf-8");
    const { tests: discovered, parseErrors } = discoverTestMetadataFromSource(filePath, source);
    for (const test of discovered) {
      tests.push({ metadata: test.metadata, filePath, line: test.line });
    }
    parseErrorCount += parseErrors.length;
  }

  return { tests, parseErrorCount };
}
