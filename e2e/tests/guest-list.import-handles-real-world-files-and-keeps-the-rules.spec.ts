/**
 * TS-198 (REQ-GUEST-LIST-MANAGEMENT) — guest import handles real-world files and keeps the rules:
 * - A file that brings a guest on a Restricted table's required-guest list back to Attending (its
 *   Attendance cell, or a Declined guest set back to Confirmed) is refused when the list would then
 *   need more seats than the table has -- as when the planner marks them Attending by hand.
 * - The "couldn't read this character" mark (U+FFFD) only stops a row when a cell the import uses
 *   says something new with it: a guest's own RSVP note (never imported) or a note the guest already
 *   has comes back fine. A guest whose saved note already has the mark can still send their RSVP.
 * - A stored value that looks like the clear token ("CLEAR", "[clear]") survives export and
 *   re-import.
 * - A value saved before today's rules (a household with a line break) doesn't block re-importing
 *   an untouched export, and a guest's RSVP between the preview and the import that the file
 *   doesn't touch no longer cancels the import.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress } from "../data/ids.js";
import { plantOldGuestText } from "../support/testDatabase.js";

type GuestState = {
  id: string;
  firstName: string;
  lastName: string;
  partyName: string | null;
  notes: string | null;
  rsvpNotes: string | null;
  plusOneNames: string | null;
  tier: string;
  rsvpStatus: string;
  dayOfAttendance: string;
  revision: number;
};

// Every column of the export, as the Guests tab maps it.
const EXPORT_MAPPING = {
  guestId: "Guest ID",
  firstName: "First name",
  lastName: "Last name",
  partyName: "Party / household",
  headcount: "Headcount",
  tier: "Tier",
  rsvpStatus: "RSVP status",
  requiresAccessibleTable: "Requires accessible table",
  dayOfAttendance: "Attendance",
  side: "Side",
  notes: "Notes",
  plusOneNames: "Plus-ones",
  version: "Version",
  ageCategory: "Age category",
};


/** The export as rows of cells -- only for files whose values hold no commas, quotes or line breaks. */
function exportRows(csv: string): { header: string[]; rows: string[][] } {
  const [header, ...rows] = csv.replace(/^﻿/, "").trim().split("\r\n").map((line) => line.split(","));
  return { header, rows };
}

function joinRows(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.join(",")).join("\r\n") + "\r\n";
}

defineQualityTest(
  {
    id: "guest-list.import-handles-real-world-files-and-keeps-the-rules.returning-guest-checked-against-restricted-list",
    title: "an import that brings a listed guest back to Attending is refused when their Restricted table's list would no longer fit",
    objective:
      "Confirms that on a Restricted table with 1 seat whose required-guest list holds one attending guest, one Not Attending guest and one Declined guest, re-importing the export with the Not Attending guest's Attendance cell set to ATTENDING -- or with the Declined guest's RSVP set to CONFIRMED (Attendance left as it was) -- is refused with a 'Nothing was imported' message naming the table and the seats needed, and neither guest changes.",
    expectedOutcome:
      "Both commits answer 422 with a message starting 'Nothing was imported:' that says the guest is on \"VIP\"'s required-guest list and the file would need 2 seats there — it has 1. Afterwards both guests are still NOT_ATTENDING and the Declined guest is still DECLINED.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:guests", "@feature:relationships", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestOf = async (id: string) => ((await (await context.request.get(api(`guests/${id}`))).json()) as { guest: GuestState }).guest;
    const person = () => uniquePersonName(testInfo.workerIndex);
    const table = await weddingData.createTable(w, { label: "VIP", capacity: 1, isRestricted: true });
    const seated = await weddingData.createGuest(w, { ...person() });
    const away = await weddingData.createGuest(w, { ...person(), dayOfAttendance: "NOT_ATTENDING" });
    const declined = await weddingData.createGuest(w, { ...person(), rsvpStatus: "DECLINED" });
    await weddingData.setRequiredGuests(w, table.id, [seated.id, away.id, declined.id]);

    const { header, rows } = exportRows(await (await context.request.get(api("guests/export"))).text());
    const col = (name: string) => header.indexOf(name);
    const withCell = (guestId: string, column: string, value: string) =>
      joinRows(header, rows.map((r) => (r[0] === guestId ? r.map((c, i) => (i === col(column) ? value : c)) : r)));

    for (const [label, csv, guest] of [
      ["Attendance cell set to ATTENDING", withCell(away.id, "Attendance", "ATTENDING"), away],
      ["Declined guest set back to Confirmed", withCell(declined.id, "RSVP status", "CONFIRMED"), declined],
    ] as const) {
      await test.step(`Refused: ${label}`, async () => {
        const res = await context.request.post(api("guests/import/commit"), { data: { csv, mapping: EXPORT_MAPPING } });
        expect(res.status(), await res.text()).toBe(422);
        const { error } = (await res.json()) as { error: string };
        expect(error).toMatch(/^Nothing was imported: /);
        expect(error).toContain(`${guest.firstName} ${guest.lastName} is on "VIP"'s required-guest list`);
        expect(error).toContain("would need 2 seats there — it has 1");
      });
    }

    await test.step("Neither guest changed", async () => {
      expect((await guestOf(away.id)).dayOfAttendance).toBe("NOT_ATTENDING");
      const stillDeclined = await guestOf(declined.id);
      expect([stillDeclined.rsvpStatus, stillDeclined.dayOfAttendance]).toEqual(["DECLINED", "NOT_ATTENDING"]);
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.import-handles-real-world-files-and-keeps-the-rules.unreadable-mark-only-stops-a-new-value",
    title: "a guest's RSVP note or private note holding the U+FFFD mark doesn't stop the export re-importing; a new value with it is refused, and a guest whose note has it can still send their RSVP",
    objective:
      "Plants (as older data could hold) a guest RSVP note and a private note containing U+FFFD, then confirms the untouched export previews on the Guests tab as unchanged with no errors and commits with nothing updated; that changing that guest's Notes cell to a new value with the mark makes the row an error saying the notes have characters that couldn't be read; and that a guest whose saved note already has the mark can still send their RSVP.",
    expectedOutcome:
      "The export's RSVP note cell holds the mark. The preview line reads '0 new, 0 updating, 1 unchanged' with no rows in error; the commit returns updatedCount 0, unchangedCount 1, and the notes are as planted. With Notes changed to 'Changed �' the preview row is an error starting 'Notes has characters that couldn't be read'. Sending the RSVP again with the note 'See you there �' answers 200.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context, playwright, baseURL }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestOf = async (id: string) => ((await (await context.request.get(api(`guests/${id}`))).json()) as { guest: GuestState }).guest;
    const guest = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), rsvpStatus: "CONFIRMED" });
    await plantOldGuestText(guest.id, { rsvpNotes: "See you there �", notes: "Allergic to nuts �" });
    const before = await guestOf(guest.id);
    const exported = await (await context.request.get(api("guests/export"))).text();

    await test.step("The untouched export previews as unchanged, with no errors", async () => {
      const { header, rows } = exportRows(exported);
      expect(rows[0][header.indexOf("Guest's RSVP note")]).toBe("See you there �");
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      await weddingGuestsPage.importGuestsFromCsvAndPreview(exported);
      await expect(weddingGuestsPage.importPreviewSummaryText()).toContainText("0 new, 0 updating, 1 unchanged");
      await expect(weddingGuestsPage.importPreviewErrorCountText()).toContainText("0 with errors");
      await weddingGuestsPage.cancelImport();
    });

    await test.step("Committing it updates no one and keeps both notes", async () => {
      const res = await context.request.post(api("guests/import/commit"), { data: { csv: exported, mapping: EXPORT_MAPPING } });
      expect(res.ok(), await res.text()).toBe(true);
      const { result } = (await res.json()) as { result: { updatedCount: number; unchangedCount: number } };
      expect(result).toMatchObject({ updatedCount: 0, unchangedCount: 1 });
      const after = await guestOf(guest.id);
      expect([after.notes, after.rsvpNotes, after.revision]).toEqual(["Allergic to nuts �", "See you there �", before.revision]);
    });

    await test.step("A new note with the mark makes that row an error", async () => {
      const { header, rows } = exportRows(exported);
      rows[0][header.indexOf("Notes")] = "Changed �";
      const res = await context.request.post(api("guests/import/preview"), {
        data: { csv: joinRows(header, rows), mapping: EXPORT_MAPPING },
      });
      expect(res.status()).toBe(200);
      const { preview } = (await res.json()) as { preview: { rows: { kind: string; reason?: string }[] } };
      expect(preview.rows[0].kind).toBe("error");
      expect(preview.rows[0].reason).toMatch(/^Notes has characters that couldn't be read \(shown as �\)/);
    });

    await test.step("A guest whose note already has the mark can still send their RSVP", async () => {
      const link = await context.request.post(api(`guests/${guest.id}/rsvp-link`), { data: {} });
      const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
      const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
      try {
        const rsvp = await visitor.post(`/api/v1/rsvp/${token}`, {
          data: { rsvpStatus: "CONFIRMED", headcount: 1, notes: "See you there �" },
        });
        expect(rsvp.status()).toBe(200);
      } finally {
        await visitor.dispose();
      }
      expect((await guestOf(guest.id)).rsvpNotes).toBe("See you there �");
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.import-handles-real-world-files-and-keeps-the-rules.clear-token-values-round-trip",
    title: "a household, note or plus-ones that is literally CLEAR or [clear] survives exporting and re-importing",
    objective:
      "Confirms that a guest whose household is 'CLEAR', private note is '[clear]' and plus-ones are '[Clear]' (values that are also the import's clear token) re-imports from the untouched export as unchanged, keeping all three -- the cells say what the guest already has -- while a CLEAR cell for another guest whose household is different still clears it.",
    expectedOutcome:
      "The commit returns updatedCount 1 and unchangedCount 1. The first guest's household, note and plus-ones are still 'CLEAR', '[clear]' and '[Clear]' and their revision hasn't moved; the second guest's household 'The Hills' is cleared (null).",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestOf = async (id: string) => ((await (await context.request.get(api(`guests/${id}`))).json()) as { guest: GuestState }).guest;
    const literal = await weddingData.createGuest(w, {
      ...uniquePersonName(testInfo.workerIndex),
      partyName: "CLEAR",
      notes: "[clear]",
      headcount: 2,
      plusOneNames: "[Clear]",
    });
    const hills = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), partyName: "The Hills" });
    const before = await guestOf(literal.id);

    await test.step("Re-import the export with only the second guest's household set to CLEAR", async () => {
      const { header, rows } = exportRows(await (await context.request.get(api("guests/export"))).text());
      const literalRow = rows.find((r) => r[0] === literal.id)!;
      expect(literalRow[header.indexOf("Party / household")]).toBe("CLEAR");
      expect(literalRow[header.indexOf("Notes")]).toBe("[clear]");
      rows.find((r) => r[0] === hills.id)![header.indexOf("Party / household")] = "CLEAR";
      const res = await context.request.post(api("guests/import/commit"), { data: { csv: joinRows(header, rows), mapping: EXPORT_MAPPING } });
      expect(res.ok(), await res.text()).toBe(true);
      const { result } = (await res.json()) as { result: { updatedCount: number; unchangedCount: number } };
      expect(result).toMatchObject({ updatedCount: 1, unchangedCount: 1 });
    });

    await test.step("The literal values are kept; the real CLEAR cleared", async () => {
      const after = await guestOf(literal.id);
      expect([after.partyName, after.notes, after.plusOneNames, after.revision]).toEqual(["CLEAR", "[clear]", "[Clear]", before.revision]);
      expect((await guestOf(hills.id)).partyName).toBeNull();
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.import-handles-real-world-files-and-keeps-the-rules.old-value-does-not-block-unchanged-row",
    title: "a value saved before today's rules doesn't block re-importing an untouched export",
    objective:
      "Plants a household name with a line break (allowed before TS-190, refused for new values today) on a guest, then confirms the untouched export previews on the Guests tab as unchanged with no errors and commits with nothing updated and the household kept.",
    expectedOutcome:
      "The preview line reads '0 new, 0 updating, 1 unchanged' with 0 with errors; the commit returns updatedCount 0 and unchangedCount 1; the household is still 'The Hills' + line break + 'West' and the revision hasn't moved.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestOf = async (id: string) => ((await (await context.request.get(api(`guests/${id}`))).json()) as { guest: GuestState }).guest;
    const guest = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex) });
    await plantOldGuestText(guest.id, { partyName: "The Hills\nWest" });
    const before = await guestOf(guest.id);
    const exported = await (await context.request.get(api("guests/export"))).text();

    await test.step("The Guests tab shows the row as unchanged, with no errors", async () => {
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      await weddingGuestsPage.importGuestsFromCsvAndPreview(exported);
      await expect(weddingGuestsPage.importPreviewSummaryText()).toContainText("0 new, 0 updating, 1 unchanged");
      await expect(weddingGuestsPage.importPreviewErrorCountText()).toContainText("0 with errors");
      await weddingGuestsPage.cancelImport();
    });

    await test.step("Committing it changes nothing", async () => {
      const res = await context.request.post(api("guests/import/commit"), { data: { csv: exported, mapping: EXPORT_MAPPING } });
      expect(res.ok(), await res.text()).toBe(true);
      const { result } = (await res.json()) as { result: { updatedCount: number; unchangedCount: number } };
      expect(result).toMatchObject({ updatedCount: 0, unchangedCount: 1 });
      const after = await guestOf(guest.id);
      expect([after.partyName, after.revision]).toEqual(["The Hills\nWest", before.revision]);
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.import-handles-real-world-files-and-keeps-the-rules.unrelated-rsvp-does-not-cancel-import",
    title: "a guest's RSVP between the preview and the import, which the file doesn't touch, doesn't cancel the import",
    objective:
      "Previews on the Guests tab an export with one guest's Tier changed and another (Confirmed) guest unchanged; then the unchanged guest answers their RSVP link again (still Confirmed, party of 1, with a note) -- which moves their revision but none of the file's values -- and confirms the import still goes through, updating only the first guest. A guest whose row the RSVP does make different is still refused (the TS-92 check).",
    expectedOutcome:
      "The preview reads '0 new, 1 updating, 1 unchanged'. After the RSVP the second guest's revision is higher. Confirming shows the import-complete summary; the first guest's tier is FAMILY and the second guest keeps their RSVP note. Then, previewing a fresh export with the first guest's tier changed, the second guest declines before confirming: the commit answers 200 with 1 updated and 1 skipped -- the first guest's tier is VIP and the second guest is still Declined.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context, playwright, baseURL }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestOf = async (id: string) => ((await (await context.request.get(api(`guests/${id}`))).json()) as { guest: GuestState }).guest;
    const changed = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), tier: "FRIEND" });
    const answering = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), rsvpStatus: "CONFIRMED" });
    const link = await context.request.post(api(`guests/${answering.id}/rsvp-link`), { data: {} });
    const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
    const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });

    const { header, rows } = exportRows(await (await context.request.get(api("guests/export"))).text());
    rows.find((r) => r[0] === changed.id)![header.indexOf("Tier")] = "FAMILY";
    const csv = joinRows(header, rows);

    try {
      await test.step("Preview, then the unchanged guest answers again before the import is confirmed", async () => {
        await weddingGuestsPage.goto(w);
        await weddingGuestsPage.openGuestsTab();
        await weddingGuestsPage.importGuestsFromCsvAndPreview(csv);
        await expect(weddingGuestsPage.importPreviewSummaryText()).toContainText("0 new, 1 updating, 1 unchanged");
        const revisionBefore = (await guestOf(answering.id)).revision;
        const res = await visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "CONFIRMED", headcount: 1, notes: "See you there" } });
        expect(res.status(), await res.text()).toBe(200);
        expect((await guestOf(answering.id)).revision).toBeGreaterThan(revisionBefore);
      });

      await test.step("The import still goes through", async () => {
        await weddingGuestsPage.confirmImport();
        expect((await guestOf(changed.id)).tier).toBe("FAMILY");
        expect((await guestOf(answering.id)).rsvpNotes).toBe("See you there");
      });

      // TS-180/TS-198: a guest whose own answer changed after the file was exported is skipped (the
      // file's older row would undo it), and the rest of the file still imports.
      await test.step("An RSVP that does change the guest's row skips that row and keeps their answer", async () => {
        const fresh = exportRows(await (await context.request.get(api("guests/export"))).text());
        fresh.rows.find((r) => r[0] === changed.id)![fresh.header.indexOf("Tier")] = "VIP";
        await weddingGuestsPage.importGuestsFromCsvAndPreview(joinRows(fresh.header, fresh.rows));
        await expect(weddingGuestsPage.importPreviewSummaryText()).toContainText("0 new, 1 updating, 1 unchanged");
        const res = await visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "DECLINED" } });
        expect(res.status(), await res.text()).toBe(200);
        const commit = await weddingGuestsPage.confirmImportExpectingRefusal();
        expect(commit.status()).toBe(200);
        const { result } = (await commit.json()) as { result: { updatedCount: number; skippedCount?: number } };
        expect(result.updatedCount).toBe(1);
        expect(result.skippedCount).toBe(1);
        expect((await guestOf(changed.id)).tier).toBe("VIP");
        expect((await guestOf(answering.id)).rsvpStatus).toBe("DECLINED");
      });
    } finally {
      await visitor.dispose();
    }
  },
);
