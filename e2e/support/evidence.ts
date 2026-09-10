/**
 * Stage 03 — named success-evidence helper and failure-diagnostics attachment (spec Section 7.4).
 *
 * Success screenshots are only ever captured through `captureSuccessCheckpoint`, always paired
 * with a checkpoint name and a validation description (never a bare screenshot with no stated
 * purpose), and only after the caller has already made the real Playwright assertion — the
 * screenshot supplements that assertion, it never substitutes for one (Section 7.4: "Screenshots
 * must supplement assertions, not replace them"). Every attached string passes through
 * `redact()` first.
 */

import type { Page, TestInfo } from "@playwright/test";
import { artifactPath } from "./artifactPaths.js";
import { redact } from "./redaction.js";

/**
 * Captures a success-checkpoint screenshot and attaches it alongside a validation description.
 * Call this AFTER the real assertion for the checkpoint has already passed — this function does
 * not assert anything itself.
 */
export async function captureSuccessCheckpoint(
  page: Page,
  testInfo: TestInfo,
  checkpointName: string,
  validationDescription: string,
): Promise<void> {
  const path = artifactPath(testInfo, checkpointName, "png");
  await page.screenshot({ path });
  await testInfo.attach(`checkpoint: ${checkpointName}`, { path, contentType: "image/png" });
  await testInfo.attach(`checkpoint: ${checkpointName} — validation`, {
    body: redact(validationDescription),
    contentType: "text/plain",
  });
}

export interface CapturedDiagnostics {
  consoleMessages: string[];
  failedRequests: string[];
}

/** Attaches redacted console-message and failed-network-request summaries. Intended to run once,
 * on failure, from the `diagnostics` fixture in e2e/fixtures/index.ts. */
export async function attachFailureDiagnostics(
  testInfo: TestInfo,
  diagnostics: CapturedDiagnostics,
): Promise<void> {
  const consoleBody = diagnostics.consoleMessages.length
    ? diagnostics.consoleMessages.map((m) => redact(m)).join("\n")
    : "(no console messages captured)";
  const requestsBody = diagnostics.failedRequests.length
    ? diagnostics.failedRequests.map((m) => redact(m)).join("\n")
    : "(no failed network requests captured)";
  await testInfo.attach("console-messages", { body: consoleBody, contentType: "text/plain" });
  await testInfo.attach("failed-network-requests", { body: requestsBody, contentType: "text/plain" });
}
