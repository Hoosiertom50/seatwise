/**
 * TS-47 (REQ-EXPORT-PRINT-RESTORE) — converts AC-065 ("Full seating chart exports as a PDF"),
 * AC-066 ("Alphabetical guest-to-table lookup exports as a PDF"), and AC-067 ("Place/escort cards
 * export in a print-ready layout"). Grouped into one test rather than three near-identical files:
 * confirmed directly in apps/web/src/lib/export-data.ts and the three export routes
 * (export/chart, export/lookup, export/cards) that all three share the exact same access gate
 * (FR-9.1/9.2/9.3 all read "Given an approved plan...": `loadExportData` throws a 409
 * ExportNotReadyError unless the plan version is APPROVED) and the exact same View-level read
 * access (exporting is a read, not an edit) -- the only thing genuinely distinct per endpoint,
 * given this app's own tooling, is which filename it serves.
 *
 * Real scope boundary (documented, not silently assumed): all three exports return a rendered PDF
 * binary, not JSON, and this app has no PDF-text-extraction library in its own dependency graph
 * (only `pdf-lib`, apps/web's own PDF-*building* library, which cannot read back rendered text) --
 * the same limitation `tables.no-seat-or-chair-number-feature-exists.spec.ts` already documented
 * for these same three endpoints. So "every table with its guests' names" (AC-065), "every guest
 * alphabetically with their table" (AC-066), and "one print-ready card per guest" (AC-067) cannot
 * be independently re-verified against the PDF's own rendered content here. What IS verified,
 * beyond that existing test's plain 200/content-type check: each endpoint's own
 * Content-Disposition filename, that the response body is a real PDF (starts with the "%PDF-"
 * magic bytes, not just a mislabeled empty or JSON body), that a View-level collaborator (not just
 * the owner) can export, and the shared APPROVED-only gate itself (409 before approval, 200 after)
 * -- which is the one concretely testable behavior implied by every AC's own "Given an approved
 * plan exists" precondition.
 */

import { request as playwrightRequest } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccount } from "../support/auth.js";
import { getEnv } from "../support/env.js";
import { uniquePersonName } from "../data/ids.js";

const EXPORT_KINDS = [
  { kind: "chart", filename: "seating-chart.pdf" },
  { kind: "lookup", filename: "guest-lookup-list.pdf" },
  { kind: "cards", filename: "place-cards.pdf" },
] as const;

defineQualityTest(
  {
    id: "export-print.chart-lookup-and-cards-export-as-pdfs-once-approved.gated-on-approval-and-real-pdfs",
    title: "the seating chart, guest lookup list, and place cards all require an Approved plan, are denied before that, and each serves a real, correctly-named PDF to any View-level collaborator once approved",
    objective:
      "Confirms all three export endpoints (chart, lookup, cards) are denied with a 409 while the plan version is still Draft, and that once it's Approved each one serves a 200 with Content-Type application/pdf, the correct Content-Disposition filename, and a response body that actually starts with the PDF magic bytes -- to a View-level collaborator, not only the wedding's owner.",
    expectedOutcome:
      "Before approval, all three export endpoints return 409 for the owner. After approval, each returns 200, application/pdf, its own correct filename, and a body starting with '%PDF-', for both the owner and a View-level collaborator.",
    requirementIds: ["REQ-EXPORT-PRINT-RESTORE"],
    tags: ["@mutating", "@feature:export", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let planVersionId = "";

    await test.step("Arrange: a generated (Draft) plan with one seated guest", async () => {
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      expect(generated.status).toBe("DRAFT");
      planVersionId = generated.id;
    });

    await test.step("Assert: all three exports are denied (409) while the plan is still Draft", async () => {
      for (const { kind } of EXPORT_KINDS) {
        const res = await context.request.get(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/export/${kind}`,
        );
        expect(res.status()).toBe(409);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("isn't Approved yet");
      }
    });

    await test.step("Act: approve the plan", async () => {
      const res = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "APPROVED");
      expect(res.status).toBe(200);
    });

    const baseURL = getEnv().APP_URL;
    const viewContext = await playwrightRequest.newContext({ baseURL });
    try {
      await test.step("Arrange: a View-level collaborator", async () => {
        const viewAccount = await signUpFreshAccount(viewContext, testInfo.workerIndex);
        await weddingData.addCollaborator(managedWedding.id, viewAccount.email, "VIEW");
      });

      for (const [label, requestContext] of [
        ["owner", context.request],
        ["View collaborator", viewContext],
      ] as const) {
        await test.step(`Assert: each export serves a real, correctly-named PDF to the ${label}`, async () => {
          for (const { kind, filename } of EXPORT_KINDS) {
            const res = await requestContext.get(
              `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/export/${kind}`,
            );
            expect(res.status(), `${kind} for ${label}`).toBe(200);
            expect(res.headers()["content-type"], `${kind} content-type for ${label}`).toBe("application/pdf");
            expect(res.headers()["content-disposition"], `${kind} filename for ${label}`).toBe(
              `attachment; filename="${filename}"`,
            );
            const body = await res.body();
            expect(body.subarray(0, 5).toString("latin1"), `${kind} magic bytes for ${label}`).toBe("%PDF-");
          }
        });
      }
    } finally {
      await viewContext.dispose();
    }
  },
);
