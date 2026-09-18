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
  /** TS-102: auto-fixture, never requested by a test directly -- see its definition below. */
  weddingCleanup: void;
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

  weddingData: async ({ context, account }, use, testInfo: TestInfo) => {
    // Depending on `account` (even though it isn't read directly) guarantees the context is
    // already authenticated before any test-data API call is made through it.
    void account;
    const weddingData = new WeddingDataSetup(context.request);
    await use(weddingData);

    // TS-102: delete every wedding this test created through the helper -- not just the one
    // `managedWedding` owns. Runs after `managedWedding`'s own teardown (Playwright tears fixtures
    // down in reverse dependency order, and managedWedding depends on this one), so the managed
    // wedding is already deleted and untracked by the time this runs; anything left here is an
    // extra wedding the test created for itself.
    //
    // This is the precise pass. It only runs for tests that actually requested `weddingData`;
    // `weddingCleanup` below is the unconditional catch-all that does not depend on that.
    const failures = await weddingData.cleanupTrackedWeddings();
    if (failures.length > 0) {
      // Never thrown, for the same reason as managedWedding's cleanup warning: a teardown throw
      // replaces whatever the test itself reported. The globalTeardown sweep is the backstop for
      // anything left behind here.
      await testInfo.attach("cleanup-warning: weddingData", {
        body:
          `Failed to delete ${failures.length} test-created wedding(s) during teardown:\n` +
          failures.map((f) => `  ${f.weddingId}: ${f.error}`).join("\n"),
        contentType: "text/plain",
      });
    }
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

  /**
   * TS-102: the unconditional per-test cleanup catch-all.
   *
   * Why this is an auto-fixture and not part of `weddingData`: Playwright only creates a fixture a
   * test actually asks for, so cleanup hung off `weddingData` silently does nothing for a test
   * that never requested it -- which is most of the tests that create weddings through the UI
   * (e.g. account-management.multiple-weddings-are-independent requests only
   * `{ account, page, evidence }`). That is the same "works only if the author remembered"
   * fragility this ticket exists to remove, so cleanup must not depend on what the test asked for.
   *
   * Why it depends only on `context` and never on `account`: depending on `account` would force a
   * fresh signup for *every* test, including the signup/login specs whose whole subject is
   * authentication and which deliberately control their own account state. `context` is a
   * Playwright built-in that is always present and has no side effects of its own. If the test
   * never authenticated, the wedding list returns 401 and this is a no-op.
   *
   * Being auto, it is set up before the test and therefore torn down *after* the other fixtures --
   * so `managedWedding` and `weddingData` have already done their precise cleanup, and whatever
   * reaches here is genuinely what they could not see.
   */
  weddingCleanup: [
    async ({ context }, use, testInfo: TestInfo) => {
      await use();

      const failures = await new WeddingDataSetup(context.request).cleanupOwnedWeddings();
      if (failures.length > 0) {
        await testInfo.attach("cleanup-warning: weddingCleanup", {
          body:
            `Failed to delete ${failures.length} wedding(s) left visible to this test's account:\n` +
            failures.map((f) => `  ${f.weddingId}: ${f.error}`).join("\n"),
          contentType: "text/plain",
        });
      }
    },
    { auto: true },
  ],

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
