/**
 * TS-190 (REQ-GUEST-LIST-MANAGEMENT) — guest import and export keep data right:
 * - Changing only the RSVP in an exported file (its Attendance column left as it was) re-imports
 *   with the same rule as everywhere else: Declined frees the seat, and a Declined guest set back to
 *   Confirmed is Attending again, waiting for a seat.
 * - Side names equal to "Both", or to each other (any case), are refused -- they would mix up
 *   guests' sides when an export comes back.
 * - A file saved by Excel in its older Windows encoding reads its accented names correctly, and a
 *   file whose letters were already lost is refused with a clear message.
 * - Re-importing an untouched export changes nothing: no guest is updated and no revision moves.
 *   The export carries Age category, which comes back unchanged.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle, uniqueToken } from "../data/ids.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";

type GuestState = {
  id: string;
  firstName: string;
  lastName: string;
  rsvpStatus: string;
  dayOfAttendance: string;
  ageCategory: string;
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

const SIDE_LABELS_MESSAGE = "Side names must be different from each other and from 'Both'.";
const UNREADABLE_MESSAGE = "This file has characters that couldn't be read — save it as 'CSV UTF-8' and choose it again.";

/** The export as rows of cells -- the test's names and values hold no commas or quotes. */
function exportRows(csv: string): { header: string[]; rows: string[][] } {
  const [header, ...rows] = csv.replace(/^﻿/, "").trim().split("\r\n").map((line) => line.split(","));
  return { header, rows };
}

function joinRows(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.join(",")).join("\r\n") + "\r\n";
}

defineQualityTest(
  {
    id: "guest-list.import-and-export-keep-data-right.rsvp-change-in-export-moves-attendance",
    title: "changing only the RSVP in an exported file frees a Declined guest's seat, and brings a guest set back to Confirmed back to Attending",
    objective:
      "Confirms that with an exported guest file re-imported by Guest ID with every column mapped, a guest whose RSVP is changed from Confirmed to Declined (their Attendance cell left as ATTENDING) becomes Not Attending and loses their seat, and a Declined guest whose RSVP is changed to Confirmed (Attendance left as NOT_ATTENDING) becomes Attending and waits unseated -- the same rule as everywhere else a guest's RSVP changes.",
    expectedOutcome:
      "Before: the Confirmed guest is seated and their Attendance cell is ATTENDING; the Declined guest's is NOT_ATTENDING. After the commit (2 updated): the first guest is DECLINED and NOT_ATTENDING with no seat in the plan; the second is CONFIRMED and ATTENDING and in the plan's unassigned guests.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestOf = async (id: string) => ((await (await context.request.get(api(`guests/${id}`))).json()) as { guest: GuestState }).guest;
    await weddingData.createTable(w, { label: "Table 1", capacity: 10 });
    const going = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), rsvpStatus: "CONFIRMED" });
    const notGoing = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), rsvpStatus: "DECLINED" });
    const plan = await weddingData.generatePlanVersion(w);

    let csv = "";
    await test.step("Arrange: export, then change only the two RSVP cells", async () => {
      expect(plan.assignments.map((a) => a.guestId)).toContain(going.id);
      expect((await guestOf(notGoing.id)).dayOfAttendance).toBe("NOT_ATTENDING");
      const { header, rows } = exportRows(await (await context.request.get(api("guests/export"))).text());
      const rowOf = (guestId: string) => rows.find((r) => r[0] === guestId)!;
      const col = (name: string) => header.indexOf(name);
      expect(rowOf(going.id)[col("Attendance")]).toBe("ATTENDING");
      expect(rowOf(notGoing.id)[col("Attendance")]).toBe("NOT_ATTENDING");
      rowOf(going.id)[col("RSVP status")] = "DECLINED";
      rowOf(notGoing.id)[col("RSVP status")] = "CONFIRMED";
      csv = joinRows(header, rows);
    });

    await test.step("Act: re-import the file", async () => {
      const res = await context.request.post(api("guests/import/commit"), { data: { csv, mapping: EXPORT_MAPPING } });
      expect(res.ok(), await res.text()).toBe(true);
      const { result } = (await res.json()) as { result: { updatedCount: number } };
      expect(result.updatedCount).toBe(2);
    });

    await test.step("Assert: Declined frees the seat; Confirmed again is Attending, waiting for a seat", async () => {
      const declined = await guestOf(going.id);
      expect([declined.rsvpStatus, declined.dayOfAttendance]).toEqual(["DECLINED", "NOT_ATTENDING"]);
      const confirmed = await guestOf(notGoing.id);
      expect([confirmed.rsvpStatus, confirmed.dayOfAttendance]).toEqual(["CONFIRMED", "ATTENDING"]);
      const after = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(after.assignments.map((a) => a.guestId)).not.toContain(going.id);
      expect(after.unassignedGuestIds).toContain(notGoing.id);
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.import-and-export-keep-data-right.side-names-must-differ",
    title: "side names equal to 'Both' or to each other are refused, when creating a wedding, saving both names, or saving one on its own",
    objective:
      "Confirms that a side name of 'Both' (any case), or two side names that are the same apart from capitals, are refused with a clear message -- when creating a wedding, when saving both names together, when saving one name that matches the other, stored one, and in the Collaborators tab's settings -- while different names still save.",
    expectedOutcome:
      "Creating with 'Sam' / 'sam' is 422 with the message on sideLabel2. Saving 'Both', ' both ', 'Sam'/'SAM' and (with 'Groom' stored as side 2) 'groom' as side 1 are each 422 with the message, and the stored names don't change. 'Alex' saves. In the settings, typing 'BOTH' as side 2 shows the message and the box goes back to the saved name.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context }, testInfo) => {
    const w = managedWedding.id;
    const collaboratorsTabPage = new CollaboratorsTabPage(page);
    const patch = (data: Record<string, string>) => context.request.patch(`/api/v1/weddings/${w}`, { data });
    const saved = async () => {
      const { wedding } = (await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as {
        wedding: { sideLabel1: string; sideLabel2: string };
      };
      return [wedding.sideLabel1, wedding.sideLabel2];
    };

    await test.step("Creating a wedding with two sides of the same name is refused", async () => {
      const created = await weddingData.createWeddingRaw({
        name: uniqueTitle(testInfo.workerIndex, "Same Sides"),
        sideLabel1: "Sam",
        sideLabel2: "sam",
      });
      expect(created.status).toBe(422);
      expect(created.body.fieldErrors?.sideLabel2).toEqual([SIDE_LABELS_MESSAGE]);
    });

    await test.step("Saving 'Both', or a name equal to the other side, is refused", async () => {
      const refused: Record<string, string>[] = [{ sideLabel1: "Both" }, { sideLabel2: " both " }, { sideLabel1: "Sam", sideLabel2: "SAM" }, { sideLabel1: "groom" }];
      for (const data of refused) {
        const res = await patch(data);
        expect(res.status(), JSON.stringify(data)).toBe(422);
        const body = (await res.json()) as { fieldErrors?: Record<string, string[]> };
        expect(Object.values(body.fieldErrors ?? {}).flat(), JSON.stringify(data)).toContain(SIDE_LABELS_MESSAGE);
      }
      expect(await saved()).toEqual(["Bride", "Groom"]);
      expect((await patch({ sideLabel1: "Alex" })).status()).toBe(200);
      expect(await saved()).toEqual(["Alex", "Groom"]);
    });

    await test.step("The settings say why and put the saved name back", async () => {
      await collaboratorsTabPage.goto(w);
      await collaboratorsTabPage.setAndLeave(collaboratorsTabPage.sideLabelInput(2), "BOTH");
      await expect(collaboratorsTabPage.message(SIDE_LABELS_MESSAGE)).toBeVisible();
      await expect(collaboratorsTabPage.sideLabelInput(2)).toHaveValue("Groom");
      expect(await saved()).toEqual(["Alex", "Groom"]);
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.import-and-export-keep-data-right.windows-encoded-file-reads-correctly",
    title: "a guest file saved in Excel's older Windows encoding imports its accented names correctly, and a file that already lost its letters is refused",
    objective:
      "Uploads, on the Guests tab, a CSV whose 'Müller' is written in windows-1252 (the single byte FC, as Excel's plain 'CSV' on Windows saves it) and confirms the preview and the saved guest read 'Müller'; then confirms a file holding the replacement character (letters already lost) is refused on the Guests tab and by the server, saying to save it as 'CSV UTF-8'.",
    expectedOutcome:
      "The preview shows a new row 'Anna Müller-<suffix>' and, once imported, the guest list has a guest with that exact last name. Choosing a file with U+FFFD in it shows the 'save it as CSV UTF-8' message and no preview; the preview API answers 422 with the same message.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context }, testInfo) => {
    const w = managedWedding.id;
    // A unique, plain-letter suffix keeps the guest findable; the accent is the point of the test.
    const suffix = uniqueToken(testInfo.workerIndex);
    const lastName = `Müller-${suffix}`;

    await test.step("A windows-1252 file previews and imports 'Müller' correctly", async () => {
      const bytes = Buffer.from(`firstName,lastName\r\nAnna,${lastName}\r\n`, "latin1");
      // The ü really is the single windows-1252 byte, not UTF-8's two.
      expect(bytes.includes(0xfc)).toBe(true);
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      await weddingGuestsPage.importGuestsFileBytesAndPreview(bytes);
      await expect(weddingGuestsPage.importPreviewRow(`Anna ${lastName}`)).toHaveCount(1);
      await weddingGuestsPage.confirmImport();
      const guests = await weddingData.listGuests(w);
      expect(guests.filter((g) => g.lastName === lastName).map((g) => g.firstName)).toEqual(["Anna"]);
    });

    await test.step("A file whose letters were already lost is refused, on the page and by the server", async () => {
      const lost = `firstName,lastName\r\nAnna,M�ller-${suffix}\r\n`;
      await weddingGuestsPage.chooseImportFileBytes(Buffer.from(lost, "utf-8"));
      await expect(weddingGuestsPage.message(UNREADABLE_MESSAGE)).toBeVisible();
      await expect(weddingGuestsPage.previewImportButtonLocator()).toHaveCount(0);

      const res = await context.request.post(`/api/v1/weddings/${w}/guests/import/preview`, {
        data: { csv: lost, mapping: { firstName: "firstName", lastName: "lastName" } },
      });
      expect(res.status()).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe(UNREADABLE_MESSAGE);
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.import-and-export-keep-data-right.unchanged-export-changes-nothing",
    title: "re-importing an untouched export updates no one and moves no revision; a file with one change updates only that guest",
    objective:
      "Confirms that the export carries an Age category column; that previewing the untouched export on the Guests tab shows every row as unchanged with nothing to import; that committing it reports 0 updated and every guest unchanged with no revision bumped (notes, which are stored encrypted, included); and that changing one cell updates only that guest.",
    expectedOutcome:
      "The child guest's Age category cell is CHILD. The preview line reads '0 new, 0 updating, 2 unchanged' and the button 'Confirm import (0 guest(s))' is disabled. The commit returns updatedCount 0 and unchangedCount 2, and both revisions are as before. With the first guest's Tier changed to FAMILY: updatedCount 1, unchangedCount 1, only that guest's revision moves, and the child is still CHILD.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestOf = async (id: string) => ((await (await context.request.get(api(`guests/${id}`))).json()) as { guest: GuestState }).guest;
    const adult = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), tier: "FRIEND", notes: "Vegan no nuts" });
    const child = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), ageCategory: "CHILD", partyName: "The Hills" });
    const before = { adult: (await guestOf(adult.id)).revision, child: (await guestOf(child.id)).revision };

    const exported = await (await context.request.get(api("guests/export"))).text();
    const { header, rows } = exportRows(exported);

    await test.step("The export carries Age category", async () => {
      expect(header).toContain("Age category");
      expect(rows.find((r) => r[0] === child.id)![header.indexOf("Age category")]).toBe("CHILD");
    });

    await test.step("The Guests tab shows every row as unchanged, with nothing to import", async () => {
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      await weddingGuestsPage.importGuestsFromCsvAndPreview(exported);
      await expect(weddingGuestsPage.importPreviewSummaryText()).toContainText("0 new, 0 updating, 2 unchanged");
      await expect(weddingGuestsPage.importPreviewRow(`${adult.firstName} ${adult.lastName}`)).toContainText("unchanged");
      await expect(weddingGuestsPage.confirmImportButtonLocator()).toHaveText("Confirm import (0 guest(s))");
      await expect(weddingGuestsPage.confirmImportButtonLocator()).toBeDisabled();
      await weddingGuestsPage.cancelImport();
    });

    await test.step("Committing the untouched export updates no one and moves no revision", async () => {
      const res = await context.request.post(api("guests/import/commit"), { data: { csv: exported, mapping: EXPORT_MAPPING } });
      expect(res.ok(), await res.text()).toBe(true);
      const { result } = (await res.json()) as { result: { updatedCount: number; unchangedCount: number } };
      expect(result).toMatchObject({ updatedCount: 0, unchangedCount: 2 });
      expect((await guestOf(adult.id)).revision).toBe(before.adult);
      expect((await guestOf(child.id)).revision).toBe(before.child);
    });

    await test.step("A file with one change updates only that guest", async () => {
      rows.find((r) => r[0] === adult.id)![header.indexOf("Tier")] = "FAMILY";
      const res = await context.request.post(api("guests/import/commit"), {
        data: { csv: joinRows(header, rows), mapping: EXPORT_MAPPING },
      });
      expect(res.ok(), await res.text()).toBe(true);
      const { result } = (await res.json()) as { result: { updatedCount: number; unchangedCount: number } };
      expect(result).toMatchObject({ updatedCount: 1, unchangedCount: 1 });
      expect((await guestOf(adult.id)).revision).toBe(before.adult + 1);
      const childNow = await guestOf(child.id);
      expect(childNow.revision).toBe(before.child);
      expect(childNow.ageCategory).toBe("CHILD");
    });
  },
);
