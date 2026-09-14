/**
 * TS-37 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — converts AC-005 ("Wedding data is fully isolated from
 * other weddings on the same account"). The workbook's manual case exercises isolation across
 * many resource types (guests, rules, tables, comments, activity, access grants); this automated
 * test scopes to guests -- the resource every other test in this suite already depends on
 * (guest-management.spec.ts, guest-viewing.spec.ts) -- as a representative, real check of the
 * same underlying access boundary (`requireAccess`/`getGuestForWedding` scoping by weddingId),
 * both through the UI (Assert 1) and directly against the API (Assert 2). Broader, deeper
 * cross-tenant access-control coverage across every resource type is REQ-ACCESS-CONTROL's own
 * story (TS-39), not duplicated here.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";

defineQualityTest(
  {
    id: "account-management.wedding-data-isolation.guest-not-visible-across-weddings",
    title: "a guest created in one wedding is invisible from another wedding on the same account",
    objective:
      "Confirms that a guest created under one of a planner's weddings never appears, through the UI or a direct API request, under a different wedding the same planner owns.",
    expectedOutcome:
      "Wedding B's Guests tab does not show the guest created in Wedding A, and a direct API request for that exact guest id scoped to Wedding B's id returns 404 rather than the guest's data.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:critical", "@suite:regression"],
  },
  async ({ weddingData: dataSetup, weddingGuestsPage, context, evidence }, testInfo) => {
    let weddingAId = "";
    let weddingBId = "";
    let guestAId = "";

    const { firstName, lastName } = await test.step("Arrange: create two weddings on the same account, with one guest in Wedding A only", async () => {
      const weddingA = await dataSetup.createWedding(uniqueTitle(testInfo.workerIndex, "Wedding A"));
      const weddingB = await dataSetup.createWedding(uniqueTitle(testInfo.workerIndex, "Wedding B"));
      weddingAId = weddingA.id;
      weddingBId = weddingB.id;
      const name = uniquePersonName(testInfo.workerIndex);
      const guest = await dataSetup.createGuest(weddingAId, name);
      guestAId = guest.id;
      return name;
    });

    try {
      await test.step("Act: open Wedding B's Guests tab (a read, not a write)", async () => {
        await weddingGuestsPage.goto(weddingBId);
        await weddingGuestsPage.openGuestsTab();
      });

      await test.step("Assert: Wedding A's guest is not visible under Wedding B", async () => {
        const row = weddingGuestsPage.guestRow(`${firstName} ${lastName}`);
        await expect(row.locator()).not.toBeVisible();
      });

      await test.step("Assert: Wedding A's guest data is not directly reachable through Wedding B's own API path", async () => {
        const weddingBGuestsRes = await context.request.get(`/api/v1/weddings/${weddingBId}/guests`);
        expect(weddingBGuestsRes.ok()).toBe(true);
        const { guests } = (await weddingBGuestsRes.json()) as { guests: { firstName: string; lastName: string }[] };
        expect(guests.some((g) => g.firstName === firstName && g.lastName === lastName)).toBe(false);
      });

      await test.step("Assert: fetching Wedding A's exact guest id scoped under Wedding B's own path is a 404, not the guest's data", async () => {
        const crossWeddingRes = await context.request.get(`/api/v1/weddings/${weddingBId}/guests/${guestAId}`);
        expect(crossWeddingRes.status()).toBe(404);
      });

      await evidence.checkpoint(
        "guest-not-visible-in-other-wedding",
        `Wedding B's Guests tab has no row for "${firstName} ${lastName}", who exists only under Wedding A.`,
      );
    } finally {
      // Arrange created two weddings directly through `weddingData` rather than the single-wedding
      // `managedWedding` fixture (this test needs two), so both are cleaned up here the same way
      // `managedWedding` does -- a warning attached on failure rather than masking the test's own
      // result.
      for (const id of [weddingAId, weddingBId]) {
        try {
          await dataSetup.deleteWedding(id);
        } catch (err) {
          await testInfo.attach(`cleanup-warning: wedding ${id}`, {
            body: `Failed to delete wedding ${id} during teardown: ${err instanceof Error ? err.message : String(err)}`,
            contentType: "text/plain",
          });
        }
      }
    }
  },
);
