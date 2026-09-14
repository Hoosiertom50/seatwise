/**
 * TS-40 (REQ-GUEST-LIST-MANAGEMENT) — converts AC-017 ("Bulk import preview correctly classifies
 * every row before anything is saved"). Traced directly against `classifyGuestImport`
 * (packages/db/src/queries/guest-import.ts) and its schema (packages/shared/src/schemas/
 * guest-import.ts), which this preview endpoint (POST .../guests/import/preview) calls and never
 * writes from.
 *
 * One CSV, mapped by header name (guestId/firstName/lastName/partyName/notes), exercises every
 * classification outcome in a single pass:
 *  - a brand-new guest (kind: "new")
 *  - a clean update to an existing guest by guestId (kind: "update")
 *  - a blank cell on that update row (partyName) -- must leave the existing value untouched, not
 *    clear it
 *  - a "CLEAR" token on that same update row (notes) -- must explicitly null the field, distinct
 *    from a blank cell
 *  - two rows both citing the same guestId -- "referenced by more than one row" (kind: "error")
 *  - a row citing a guestId that doesn't exist in this wedding -- "No guest with ID ... exists"
 *    (kind: "error")
 * and confirms the preview's summary counts (newCount/updatingCount/errorCount/totalRows) add up
 * correctly across all of them.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

interface GuestImportRow {
  rowNumber: number;
  kind: "new" | "update" | "error";
  guestId?: string;
  reason?: string;
  preview: { partyName?: string | null; notes?: string | null };
}

function csvRow(cells: string[]): string {
  return cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(",");
}

defineQualityTest(
  {
    id: "guest-list.bulk-import-preview-classifies-new-update-and-error-rows.six-row-csv",
    title: "bulk-import preview classifies new, update, blank-leaves-unchanged, CLEAR-clears, and both error rows correctly, writing nothing",
    objective:
      "Confirms the import preview endpoint correctly classifies a brand-new guest, a clean update by guestId, a blank cell that must leave an existing value unchanged, a CLEAR token that must null a field, a guestId referenced by more than one row, and an unknown guestId -- with accurate summary counts -- while writing nothing to the database.",
    expectedOutcome:
      "The preview reports exactly one new row, one clean update row, and two error rows (one 'referenced by more than one row', one 'No guest with ID ... exists'), with newCount/updatingCount/errorCount/totalRows all correct, and no guest is actually created or modified by the preview call itself.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let existingGuestId = "";
    let existingPartyName = "";
    const existingName = uniquePersonName(testInfo.workerIndex);
    const newRowName = uniquePersonName(testInfo.workerIndex);
    const duplicateRowsName = uniquePersonName(testInfo.workerIndex);

    await test.step("Arrange: one existing guest with a partyName and notes already set, to update", async () => {
      existingPartyName = "Original Household";
      const existing = await weddingData.createGuest(managedWedding.id, {
        ...existingName,
        partyName: existingPartyName,
        notes: "Original notes",
      });
      existingGuestId = existing.id;
    });

    const csvBefore = () =>
      context.request
        .get(`/api/v1/weddings/${managedWedding.id}/guests`)
        .then((r) => r.json())
        .then((b: { guests: unknown[] }) => b.guests.length);

    const preview = await test.step("Act: preview a CSV covering new/update/blank/CLEAR/duplicate-id/unknown-id", async () => {
      const guestsBefore = await csvBefore();

      const header = "guestId,firstName,lastName,partyName,notes";
      const rows = [
        // 1: brand new guest -- no guestId cell.
        csvRow(["", newRowName.firstName, newRowName.lastName, "New Household", "Fresh notes"]),
        // 2: clean update -- partyName blank (leave existing value), notes = CLEAR (null it).
        csvRow([existingGuestId, existingName.firstName, existingName.lastName, "", "CLEAR"]),
        // 3 & 4: the same guestId cell cited twice -- the ambiguity check runs before the
        // existence check, so both become errors regardless of whether that id is real.
        csvRow(["duplicate-cited-id", duplicateRowsName.firstName, duplicateRowsName.lastName, "", ""]),
        csvRow(["duplicate-cited-id", duplicateRowsName.firstName, duplicateRowsName.lastName, "", ""]),
        // 5: guestId that doesn't exist in this wedding at all.
        csvRow(["00000000-0000-0000-0000-000000000000", "Nobody", "Real", "", ""]),
      ].join("\n");
      const csv = `${header}\n${rows}`;

      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/guests/import/preview`, {
        data: {
          csv,
          mapping: { guestId: "guestId", firstName: "firstName", lastName: "lastName", partyName: "partyName", notes: "notes" },
        },
      });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        preview: { rows: GuestImportRow[]; summary: { newCount: number; updatingCount: number; errorCount: number; totalRows: number } };
      };

      // The preview step must never write -- same guest count as before the call.
      expect(await csvBefore()).toBe(guestsBefore);
      return body.preview;
    });

    await test.step("Assert: row 1 (new guest) is classified 'new'", async () => {
      expect(preview.rows[0].kind).toBe("new");
    });

    await test.step("Assert: row 2 (clean update) is classified 'update' for the right guest, blank partyName leaves it unset in the preview data, and CLEAR nulls notes", async () => {
      const row = preview.rows[1];
      expect(row.kind).toBe("update");
      expect(row.guestId).toBe(existingGuestId);
      // A blank cell means "don't touch this field" -- it's simply absent from the preview data,
      // not an explicit null (which would mean "clear it").
      expect(row.preview.partyName).toBeUndefined();
      expect(row.preview.notes).toBeNull();
    });

    await test.step("Assert: rows 3 and 4 (same guestId cited twice) are both errors naming the ambiguity", async () => {
      expect(preview.rows[2].kind).toBe("error");
      expect(preview.rows[2].reason).toContain("referenced by more than one row");
      expect(preview.rows[3].kind).toBe("error");
      expect(preview.rows[3].reason).toContain("referenced by more than one row");
    });

    await test.step("Assert: row 5 (unknown guestId) is an error naming the missing id", async () => {
      const row = preview.rows[4];
      expect(row.kind).toBe("error");
      expect(row.reason).toContain("No guest with ID");
      expect(row.reason).toContain("00000000-0000-0000-0000-000000000000");
    });

    await test.step("Assert: summary counts add up correctly across all five rows", async () => {
      expect(preview.summary.totalRows).toBe(5);
      expect(preview.summary.newCount).toBe(1);
      expect(preview.summary.updatingCount).toBe(1);
      expect(preview.summary.errorCount).toBe(3);
    });

    await test.step("Assert: the existing guest's real data is untouched by the preview call (preview never writes)", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests/${existingGuestId}`);
      const { guest } = (await res.json()) as { guest: { partyName: string | null; notes: string | null } };
      expect(guest.partyName).toBe(existingPartyName);
      expect(guest.notes).toBe("Original notes");
    });
  },
);
