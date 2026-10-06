/**
 * TS-180 (REQ-GUEST-LIST-MANAGEMENT) — the guest CSV export, re-imported, leaves guests as they are:
 * - The export writes each guest's side with the wedding's own side names, so a wedding whose sides
 *   are called "Groom" / "Bride" (first side "Groom") no longer swaps every guest's side on
 *   re-import; an older export's BRIDE / GROOM still means the stored value. The file starts with a
 *   byte-order mark (for Excel), is never cached, and carries Plus-ones and Version columns.
 * - Re-importing an older export flags guests changed in Seatwise since it was exported, leaves
 *   them alone unless the planner ticks "Overwrite guests changed since the export", and the
 *   Guests tab shows them and the box.
 * - A guest deleted after an import has read the file, but before it writes, refuses the import
 *   naming them, rather than being counted as "updated". The wedding's lock is held from the local
 *   test database to stop the import at exactly that point.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { holdWeddingLock } from "../support/testDatabase.js";

type Guest = {
  id: string;
  firstName: string;
  lastName: string;
  side: string;
  plusOneNames: string | null;
  revision: number;
};

type ImportRow = { kind: string; guestId?: string; reason?: string; preview: { side?: string } };
type Preview = {
  rows: ImportRow[];
  summary: { newCount: number; updatingCount: number; unchangedCount: number; conflictCount: number; errorCount: number };
};

const EXPORT_MAPPING = {
  guestId: "Guest ID",
  firstName: "First name",
  lastName: "Last name",
  side: "Side",
  plusOneNames: "Plus-ones",
  version: "Version",
};

/** The export as rows of cells -- the test's names and values hold no commas or quotes. */
function exportRows(csv: string): { header: string[]; rows: string[][] } {
  const [header, ...rows] = csv.replace(/^﻿/, "").trim().split("\r\n").map((line) => line.split(","));
  return { header, rows };
}

defineQualityTest(
  {
    id: "guest-list.csv-export-re-imports-without-losing-changes.side-names-round-trip",
    title: "the guest export writes the wedding's own side names, so a wedding whose first side is 'Groom' re-imports its export with every side unchanged",
    objective:
      "Confirms that for a wedding whose sides are named 'Groom' (first) and 'Bride' (second), the guest CSV export starts with a byte-order mark, is marked no-store, writes Side as Groom/Bride/Both and adds Plus-ones and Version columns; that committing that export back by Guest ID leaves every guest's side and plus-ones as they were; and that an older file's stored values BRIDE / GROOM are still read as those stored sides.",
    expectedOutcome:
      "The response starts with bytes EF BB BF and has Cache-Control no-store. The last three headers are 'Plus-ones', 'Version' and 'Age category'. The BRIDE guest's Side cell is 'Groom', the GROOM guest's 'Bride', the BOTH guest's 'Both' with Plus-ones 'Jamie Lee' and Version equal to their revision. After the re-import the sides are still BRIDE, GROOM, BOTH and the plus-ones still 'Jamie Lee'. A preview of 'BRIDE' and 'GROOM' cells reads BRIDE and GROOM.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestsNow = async () => ((await (await context.request.get(api("guests"))).json()) as { guests: Guest[] }).guests;
    await weddingData.updateWedding(w, { sideLabel1: "Groom", sideLabel2: "Bride" });
    const first = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), side: "BRIDE" });
    const second = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), side: "GROOM" });
    const both = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), side: "BOTH", headcount: 2, plusOneNames: "Jamie Lee" });

    let exported = "";
    await test.step("The export starts with a byte-order mark, isn't cached, and writes the wedding's side names", async () => {
      const res = await context.request.get(api("guests/export"));
      expect(res.status()).toBe(200);
      expect(res.headers()["cache-control"]).toBe("no-store");
      const bytes = await res.body();
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      exported = bytes.toString("utf-8");

      const { header, rows } = exportRows(exported);
      // TS-190: Age category comes after them.
      expect(header.slice(-3)).toEqual(["Plus-ones", "Version", "Age category"]);
      const cell = (guestId: string, column: string) => rows.find((r) => r[0] === guestId)![header.indexOf(column)];
      expect(cell(first.id, "Side")).toBe("Groom");
      expect(cell(second.id, "Side")).toBe("Bride");
      expect(cell(both.id, "Side")).toBe("Both");
      expect(cell(both.id, "Plus-ones")).toBe("Jamie Lee");
      const current = (await guestsNow()).find((g) => g.id === both.id)!;
      expect(cell(both.id, "Version")).toBe(String(current.revision));
    });

    await test.step("Committing the export back leaves every side and plus-one as it was", async () => {
      const res = await context.request.post(api("guests/import/commit"), { data: { csv: exported, mapping: EXPORT_MAPPING } });
      expect(res.ok(), await res.text()).toBe(true);
      const after = await guestsNow();
      const sideOf = (id: string) => after.find((g) => g.id === id)!.side;
      expect([sideOf(first.id), sideOf(second.id), sideOf(both.id)]).toEqual(["BRIDE", "GROOM", "BOTH"]);
      expect(after.find((g) => g.id === both.id)!.plusOneNames).toBe("Jamie Lee");
    });

    await test.step("An older export's BRIDE / GROOM cells still mean those stored sides", async () => {
      const csv = `guestId,firstName,lastName,side\n${first.id},${first.firstName},${first.lastName},BRIDE\n${second.id},${second.firstName},${second.lastName},GROOM\n`;
      const res = await context.request.post(api("guests/import/preview"), {
        data: { csv, mapping: { guestId: "guestId", firstName: "firstName", lastName: "lastName", side: "side" } },
      });
      expect(res.ok()).toBe(true);
      const { preview } = (await res.json()) as { preview: Preview };
      expect(preview.rows.map((r) => r.preview.side)).toEqual(["BRIDE", "GROOM"]);
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.csv-export-re-imports-without-losing-changes.changed-since-export",
    title: "re-importing an older export flags guests changed since it was exported and leaves them alone unless the planner ticks to overwrite",
    objective:
      "Confirms that after a guest is renamed in Seatwise, a preview of the export taken before the rename classifies that guest's row as changed since the export (with the reason) while the untouched guest's row is unchanged (TS-190); that the Guests tab shows the row and an 'Overwrite guests changed since the export' box that adds it to the import count; that committing without the overwrite flag skips that guest and reports it skipped; and that committing with the flag writes the file's values.",
    expectedOutcome:
      "The preview has conflictCount 1 for the renamed guest, kind 'conflict', reason containing 'Changed in Seatwise since this file was exported', and unchangedCount 1 (updatingCount 0) for the other. On the Guests tab one 'changed' row shows, and ticking the box raises the Confirm count from 0 to 1. The plain commit returns updatedCount 0, unchangedCount 1, skippedCount 1 and the guest keeps the new name; the commit with overwriteChanged true puts the exported name back.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestsNow = async () => ((await (await context.request.get(api("guests"))).json()) as { guests: Guest[] }).guests;
    const kept = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const renamed = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const exported = await (await context.request.get(api("guests/export"))).text();

    await test.step("Someone renames a guest in Seatwise after the export", async () => {
      const res = await context.request.patch(api(`guests/${renamed.id}`), { data: { firstName: "Renamed" } });
      expect(res.ok()).toBe(true);
    });

    await test.step("The preview flags that guest as changed since the export", async () => {
      const res = await context.request.post(api("guests/import/preview"), { data: { csv: exported, mapping: EXPORT_MAPPING } });
      expect(res.ok(), await res.text()).toBe(true);
      const { preview } = (await res.json()) as { preview: Preview };
      expect(preview.summary.conflictCount).toBe(1);
      // TS-190: the untouched guest's row is the same as the guest already is.
      expect(preview.summary.updatingCount).toBe(0);
      expect(preview.summary.unchangedCount).toBe(1);
      const row = preview.rows.find((r) => r.guestId === renamed.id)!;
      expect(row.kind).toBe("conflict");
      expect(row.reason).toContain("Changed in Seatwise since this file was exported");
      expect(preview.rows.find((r) => r.guestId === kept.id)!.kind).toBe("unchanged");
    });

    await test.step("The Guests tab shows the changed row and the box to overwrite it", async () => {
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      await weddingGuestsPage.importGuestsFromCsvAndPreview(exported);
      await expect(weddingGuestsPage.importChangedSinceExportRows()).toHaveCount(1);
      await expect(weddingGuestsPage.confirmImportButtonLocator()).toHaveText("Confirm import (0 guest(s))");
      await weddingGuestsPage.overwriteChangedCheckbox().check();
      await expect(weddingGuestsPage.confirmImportButtonLocator()).toHaveText("Confirm import (1 guest(s))");
      await weddingGuestsPage.cancelImport();
    });

    await test.step("Committing without the box leaves the changed guest alone and says so", async () => {
      const res = await context.request.post(api("guests/import/commit"), { data: { csv: exported, mapping: EXPORT_MAPPING } });
      expect(res.ok(), await res.text()).toBe(true);
      const { result } = (await res.json()) as { result: { updatedCount: number; skippedCount: number; unchangedCount: number } };
      expect(result).toMatchObject({ updatedCount: 0, unchangedCount: 1, skippedCount: 1 });
      expect((await guestsNow()).find((g) => g.id === renamed.id)!.firstName).toBe("Renamed");
    });

    await test.step("Committing with the box writes the file's values", async () => {
      const res = await context.request.post(api("guests/import/commit"), {
        data: { csv: exported, mapping: EXPORT_MAPPING, overwriteChanged: true },
      });
      expect(res.ok(), await res.text()).toBe(true);
      const { result } = (await res.json()) as { result: { updatedCount: number; skippedCount: number } };
      expect(result.skippedCount).toBe(0);
      expect((await guestsNow()).find((g) => g.id === renamed.id)!.firstName).toBe(renamed.firstName);
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.csv-export-re-imports-without-losing-changes.deleted-during-commit",
    title: "a guest deleted after an import has read the file, but before it writes, refuses the import naming them instead of counting them as updated",
    objective:
      "Holds the wedding's lock from outside the app so a re-import of the export stops after it has read and checked the file but before it locks the guests, deletes one of the file's guests meanwhile, then lets the import carry on. Confirms the import is refused naming the deleted guest and writes nothing, rather than reporting that guest as updated.",
    expectedOutcome:
      "The commit returns 409 with a message containing 'deleted since you previewed it' and the deleted guest's name. The deleted guest is gone, and every other guest still has the revision it had before the import.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestsNow = async () => ((await (await context.request.get(api("guests"))).json()) as { guests: Guest[] }).guests;
    const kept = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const removed = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const exported = await (await context.request.get(api("guests/export"))).text();
    const before = await guestsNow();

    await test.step("The guest is deleted while the import waits at the wedding's lock", async () => {
      const lock = await holdWeddingLock(w);
      let pending;
      try {
        pending = context.request.post(api("guests/import/commit"), {
          data: { csv: exported, mapping: { guestId: "Guest ID", firstName: "First name", lastName: "Last name" } },
        });
        await lock.waitForWaiters(1);
        await weddingData.deleteGuest(w, removed.id);
      } finally {
        await lock.release();
      }
      const commit = await pending;
      expect(commit.status()).toBe(409);
      const { error } = (await commit.json()) as { error: string };
      expect(error).toContain("deleted since you previewed it");
      expect(error).toContain(`${removed.firstName} ${removed.lastName}`);
    });

    await test.step("Nothing was written", async () => {
      const after = await guestsNow();
      expect(after.some((g) => g.id === removed.id)).toBe(false);
      const keptBefore = before.find((g) => g.id === kept.id)!;
      expect(after.find((g) => g.id === kept.id)!.revision).toBe(keptBefore.revision);
    });
  },
);
