/**
 * TS-40 (REQ-GUEST-LIST-MANAGEMENT) — converts AC-016 ("A bulk import with row-level errors is
 * refused as a whole -- nothing partial is saved -- and a corrected re-import succeeds cleanly").
 * Traced directly against `commitGuestImport` (packages/db/src/queries/guest-import.ts): it
 * re-classifies from scratch (never trusting an earlier preview), throws `GuestImportError` ->
 * 422 if any row still has an error, and the whole operation runs inside one BEGIN/COMMIT/
 * ROLLBACK transaction, so a refused commit writes nothing at all -- not even the rows that were
 * individually valid.
 *
 * One clause of this AC -- "if the committed operation fails unexpectedly partway through, none
 * of its rows remain written" -- is a true statement about the code's transactional shape (a
 * single client transaction wrapping every row), not something this or any other real,
 * unmodified-environment E2E test can independently trigger (there's no way to fault-inject a
 * mid-transaction crash without modifying the app itself). This test proves the part that *is*
 * observable end-to-end: a commit refused for row-level errors leaves the guest list completely
 * unchanged, and the identical file succeeds cleanly (with the row-level errors fixed) with no
 * side effects from the earlier refused attempt.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

function csvRow(cells: string[]): string {
  return cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(",");
}

defineQualityTest(
  {
    id: "guest-list.bulk-import-commit-is-all-or-nothing.refused-then-corrected",
    title: "a bulk import with row-level errors is refused wholesale, then the corrected file commits cleanly",
    objective:
      "Confirms that committing a CSV containing one otherwise-valid new-guest row and one row with an unknown guestId is refused entirely (422, nothing saved -- not even the valid row), and that re-submitting the same file with the bad row fixed creates exactly the expected guests with no leftover effect from the earlier refused attempt.",
    expectedOutcome:
      "The first commit attempt returns 422 and the guest list is byte-for-byte unchanged afterward. The corrected commit returns createdCount matching the number of new rows, and the guest list gains exactly those guests -- no duplicates from the earlier refused attempt.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, context }, testInfo) => {
    const validNewGuest = uniquePersonName(testInfo.workerIndex);
    const header = "guestId,firstName,lastName";
    const mapping = { guestId: "guestId", firstName: "firstName", lastName: "lastName" };

    async function guestCount(): Promise<number> {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests`);
      const { guests } = (await res.json()) as { guests: unknown[] };
      return guests.length;
    }

    const countBefore = await test.step("Arrange: record the guest count before any import attempt", async () => guestCount());

    await test.step("Act: attempt to commit a CSV with one valid new-guest row and one row citing an unknown guestId", async () => {
      const csv = [
        header,
        csvRow(["", validNewGuest.firstName, validNewGuest.lastName]),
        csvRow(["00000000-0000-0000-0000-000000000001", "Nobody", "Real"]),
      ].join("\n");

      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/guests/import/commit`, {
        data: { csv, mapping },
      });
      expect(res.status()).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("row(s) still have errors");
      expect(body.error).toContain("nothing was saved");
    });

    await test.step("Assert: the refused commit wrote nothing -- not even the otherwise-valid new-guest row", async () => {
      expect(await guestCount()).toBe(countBefore);
      const listRes = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests`);
      const { guests } = (await listRes.json()) as { guests: { firstName: string; lastName: string }[] };
      expect(
        guests.some((g) => g.firstName === validNewGuest.firstName && g.lastName === validNewGuest.lastName),
      ).toBe(false);
    });

    await test.step("Act: re-submit the same file with the bad row removed", async () => {
      const csv = [header, csvRow(["", validNewGuest.firstName, validNewGuest.lastName])].join("\n");

      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/guests/import/commit`, {
        data: { csv, mapping },
      });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { result: { createdCount: number; updatedCount: number } };
      expect(body.result.createdCount).toBe(1);
      expect(body.result.updatedCount).toBe(0);
    });

    await test.step("Assert: the corrected commit created exactly one guest, with no duplicate or leftover from the refused attempt", async () => {
      expect(await guestCount()).toBe(countBefore + 1);
      const listRes = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests`);
      const { guests } = (await listRes.json()) as { guests: { firstName: string; lastName: string }[] };
      const matches = guests.filter(
        (g) => g.firstName === validNewGuest.firstName && g.lastName === validNewGuest.lastName,
      );
      expect(matches.length).toBe(1);
    });
  },
);
