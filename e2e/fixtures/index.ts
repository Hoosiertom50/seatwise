/**
 * Stage 03 — typed fixtures giving a test access to page objects, test-data helpers, and evidence
 * capture (spec Stage 03 acceptance criterion: "A test can request page objects, data helpers,
 * and evidence through typed fixtures"). Every application test should import `test`/`expect`
 * from this module instead of directly from `@playwright/test`.
 *
 * Fixture dependency shape:
 *   context (Playwright built-in)
 *     -> account          (signs up a fresh, worker-safe user; sets the app's httpOnly auth
 *                           cookie on `context` — no credential is ever stored on this object)
 *     -> weddingData       (data setup/cleanup interface bound to the same authenticated context)
 *     -> managedWedding    (creates one wedding for the test, cleans it up after — cleanup
 *                           failures are attached as a warning, never thrown over the test's own
 *                           result; see Stage 03 audit gate)
 *   page (Playwright built-in)
 *     -> loginPage / signupPage / weddingGuestsPage   (page objects, one per test — no shared
 *                                                       mutable state between tests)
 *     -> evidence          (success-checkpoint capture, scoped to this test's own page/testInfo)
 *   diagnostics (auto-fixture): captures console messages and failed requests for the whole
 *     test, attaching a redacted summary only when the test did not end in its expected state.
 */

import { test as base, type TestInfo } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage.js";
import { SignupPage } from "../pages/SignupPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { WeddingDataSetup, type CreatedWedding } from "../data/api.js";
import { uniqueTitle } from "../data/ids.js";
import { signUpFreshAccount, type SignedUpAccount } from "../support/auth.js";
import { captureSuccessCheckpoint, attachFailureDiagnostics } from "../support/evidence.js";
import { createDefineQualityTest } from "../../playwright-framework/metadata/defineQualityTest.js";

export interface EvidenceHelper {
  checkpoint(name: string, validationDescription: string): Promise<void>;
}

interface QualityFixtures {
  account: SignedUpAccount;
  loginPage: LoginPage;
  signupPage: SignupPage;
  weddingGuestsPage: WeddingGuestsPage;
  weddingData: WeddingDataSetup;
  managedWedding: CreatedWedding;
  evidence: EvidenceHelper;
  diagnostics: void;
}

export const test = base.extend<QualityFixtures>({
  account: async ({ context }, use, testInfo: TestInfo) => {
    const account = await signUpFreshAccount(context.request, testInfo.workerIndex);
    await use(account);
  },

  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  signupPage: async ({ page }, use) => {
    await use(new SignupPage(page));
  },

  weddingGuestsPage: async ({ page }, use) => {
    await use(new WeddingGuestsPage(page));
  },

  weddingData: async ({ context, account }, use) => {
    // Depending on `account` (even though it isn't read directly) guarantees the context is
    // already authenticated before any test-data API call is made through it.
    void account;
    await use(new WeddingDataSetup(context.request));
  },

  managedWedding: async ({ weddingData }, use, testInfo: TestInfo) => {
    const wedding = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Playwright Wedding"));
    await use(wedding);
    try {
      await weddingData.deleteWedding(wedding.id);
    } catch (err) {
      // Stage 03 audit gate: "cleanup errors are reported without hiding the original failure."
      // A teardown throw here would replace whatever the test itself reported, so this attaches
      // a visible, redaction-passed warning instead of throwing.
      await testInfo.attach("cleanup-warning: managedWedding", {
        body: `Failed to delete wedding ${wedding.id} during teardown: ${
          err instanceof Error ? err.message : String(err)
        }`,
        contentType: "text/plain",
      });
    }
  },

  evidence: async ({ page }, use, testInfo: TestInfo) => {
    await use({
      checkpoint: (name, validationDescription) =>
        captureSuccessCheckpoint(page, testInfo, name, validationDescription),
    });
  },

  diagnostics: [
    async ({ page }, use, testInfo: TestInfo) => {
      const consoleMessages: string[] = [];
      const failedRequests: string[] = [];

      const onConsole = (msg: { type(): string; text(): string }) =>
        consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
      const onRequestFailed = (req: { method(): string; url(): string; failure(): { errorText: string } | null }) =>
        failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "unknown failure"}`);

      page.on("console", onConsole);
      page.on("requestfailed", onRequestFailed);

      await use();

      page.off("console", onConsole);
      page.off("requestfailed", onRequestFailed);

      if (testInfo.status !== testInfo.expectedStatus) {
        await attachFailureDiagnostics(testInfo, { consoleMessages, failedRequests });
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";

/** `defineQualityTest`, bound to this module's fixture-extended `test` — application tests get
 * governed metadata validation (Stage 02) AND page objects/auth/test-data/evidence (Stage 03)
 * from one call. See playwright-framework/metadata/defineQualityTest.ts for the shared logic. */
export const defineQualityTest = createDefineQualityTest(test);
