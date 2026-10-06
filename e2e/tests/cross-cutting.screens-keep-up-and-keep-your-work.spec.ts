/**
 * TS-191 / TS-189 (REQ-NON-FUNCTIONAL, REQ-GUEST-LIST-MANAGEMENT, REQ-TABLE-VENUE-LAYOUT,
 * REQ-DAY-OF-EMERGENCY-MODE, REQ-MANUAL-ADJUSTMENT) — screens keep up with each other and keep
 * your work.
 * - A wedding setting that saves when you leave its box stops counting as unsaved the moment you
 *   leave it, so clicking a tab straight after doesn't ask "leave and lose them?" -- while typing,
 *   a reload still asks. Staying on the tab puts focus back on the tab that was clicked.
 * - Removing a table whose edit form had changes doesn't leave the page thinking there's unsaved work.
 * - While an import preview is being checked, the file, the column choices and Cancel can't be
 *   changed; a second file that's refused clears the first one's columns.
 * - Day-of: a seated guest can be moved to another table that has room.
 * - Seating plan: a newer plan made in another browser shows up in an open tab on its own.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueToken } from "../data/ids.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { delayResponses } from "../support/networkFaults.js";

defineQualityTest(
  {
    id: "cross-cutting.screens-keep-up-and-keep-your-work.settings-stop-counting-once-left",
    title: "a wedding setting left mid-save doesn't make the next tab click ask about unsaved changes, while typing still makes a reload ask, and Stay puts focus back on the clicked tab",
    objective:
      "Confirms that on the Collaborators tab, leaving the wedding-name box (which starts its save, held back here for 3 seconds) and clicking the Tables tab straight away opens Tables with no unsaved-changes prompt and the name is saved; that a half-typed wedding note (box not left) makes a reload bring up the browser's leave-page question; and that with an invite email typed (it only saves with Send invite), clicking a tab asks, and 'Stay on this tab' puts keyboard focus back on the tab that was clicked.",
    expectedOutcome:
      "No prompt; the Tables tab is selected; the server has the new name. Reloading with the note half-typed raises a 'beforeunload' question. With an invite email typed, clicking Tables shows the prompt; after Stay the prompt is gone, Collaborators is still the open tab and the Tables tab has focus.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:collaboration", "@feature:non-functional", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, context, page }, testInfo) => {
    const w = managedWedding.id;
    const wedding = new WeddingDetailPage(page);
    const collab = new CollaboratorsTabPage(page);
    const newName = `Renamed ${uniqueToken(testInfo.workerIndex)}`;

    await test.step("Leaving the name box and clicking a tab at once doesn't ask", async () => {
      await collab.goto(w);
      const slow = await delayResponses(page, new RegExp(`/api/v1/weddings/${w}$`), "PATCH", 3000);
      await collab.setAndLeave(collab.weddingNameInput(), newName);
      await wedding.clickTab("Tables");
      await expect(wedding.tab("Tables")).toHaveAttribute("aria-selected", "true");
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
      await expect
        .poll(async () => {
          const res = await context.request.get(`/api/v1/weddings/${w}`);
          return ((await res.json()) as { wedding: { name: string } }).wedding.name;
        })
        .toBe(newName);
      await slow.clear();
    });

    await test.step("A reload with a half-typed note (box not left) makes the browser ask", async () => {
      await wedding.openTab("Collaborators");
      await collab.weddingNoteInput().fill("Half-typed note");
      expect(await wedding.reloadAndCatchLeaveQuestion()).toBe("beforeunload");
    });

    await test.step("With an invite email typed, a tab click asks; Stay puts focus back on that tab", async () => {
      await collab.goto(w);
      await collab.inviteEmailInput().fill("someone@example.invalid");
      await wedding.clickTab("Tables");
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await wedding.stayOnTab();
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
      await expect(wedding.tab("Collaborators")).toHaveAttribute("aria-selected", "true");
      await expect(wedding.tab("Tables")).toBeFocused();
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-keep-up-and-keep-your-work.removed-table-edit-is-not-unsaved",
    title: "removing a table while its edit form has changes doesn't leave the page asking about unsaved changes",
    objective:
      "Confirms that when a table's edit form is open with a changed name and the table is then removed, the table disappears and clicking another tab opens it with no unsaved-changes prompt (the removed table's edit used to keep counting as unsaved with no form left to save or cancel).",
    expectedOutcome:
      "The table's Remove button is gone; clicking Guests selects the Guests tab and no prompt appears.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const label = `Edited ${uniqueToken(testInfo.workerIndex)}`;
    await weddingData.createTable(w, { label, capacity: 8 });
    const tables = new TablesTabPage(page);
    const wedding = new WeddingDetailPage(page);

    await test.step("Open the table's edit form and change its name", async () => {
      await tables.goto(w);
      await tables.openTableEdit(label);
      await tables.fillTableEdit(label, { name: `${label} changed` });
    });

    await test.step("Remove the table, then switch tabs: no prompt", async () => {
      await tables.removeTable(label);
      await expect(tables.removeTableButton(label)).toHaveCount(0);
      await wedding.clickTab("Guests");
      await expect(wedding.tab("Guests")).toHaveAttribute("aria-selected", "true");
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-keep-up-and-keep-your-work.import-preview-holds-still-and-refused-file-clears",
    title: "while an import preview is being checked the file, column choices and Cancel can't change, and a refused second file clears the first file's columns",
    objective:
      "Confirms that with a guest CSV chosen and its preview answer held back for 2.5 seconds, the file chooser, the First name column picker and Cancel are disabled until the preview arrives and enabled again after; and that choosing a second file with two columns of the same name is refused with a message and leaves no column pickers, Preview button or preview from the first file on screen.",
    expectedOutcome:
      "During the held preview: file input, First name picker and Cancel disabled. After it: the preview summary shows and all three are enabled. After the refused file: the 'Two columns are both called' message shows, and the column-mapping heading, Preview button and preview summary are gone.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }, testInfo) => {
    const w = managedWedding.id;
    const guests = new WeddingGuestsPage(page);
    const person = uniquePersonName(testInfo.workerIndex);

    await test.step("Choose a file and hold its preview: the import controls wait", async () => {
      await guests.goto(w);
      await guests.chooseImportFile(`firstName,lastName\n${person.firstName},${person.lastName}\n`);
      await expect(guests.importMappingHeading()).toBeVisible();
      const slow = await delayResponses(page, /\/guests\/import\/preview$/, "POST", 2500);
      await guests.previewImportButtonLocator().click();
      await expect(guests.importFileInputLocator()).toBeDisabled();
      await expect(guests.importMappingSelect(/^First name \*$/)).toBeDisabled();
      await expect(guests.cancelImportButton()).toBeDisabled();
      await expect(guests.importPreviewSummary()).toBeVisible({ timeout: 10_000 });
      await expect(guests.importFileInputLocator()).toBeEnabled();
      await expect(guests.importMappingSelect(/^First name \*$/)).toBeEnabled();
      await expect(guests.cancelImportButton()).toBeEnabled();
      await slow.clear();
    });

    await test.step("A refused second file clears the first file's columns and preview", async () => {
      await guests.chooseImportFile("firstName,firstName\nA,B\n", "duplicate-columns.csv");
      await expect(guests.importError(/Two columns are both called "firstName"/)).toBeVisible();
      await expect(guests.importMappingHeading()).toHaveCount(0);
      await expect(guests.previewImportButtonLocator()).toHaveCount(0);
      await expect(guests.importPreviewSummary()).toHaveCount(0);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-keep-up-and-keep-your-work.day-of-moves-a-seated-guest",
    title: "Day-of mode moves a seated guest to another table with room, offering only tables with enough free seats",
    objective:
      "Confirms (Tom's decision on TS-191) that in Day-of mode a seated guest's 'Move to…' list offers every other table with enough free seats for their party -- not their own table and not a full one -- and that choosing one moves just that guest there, on screen and on the server.",
    expectedOutcome:
      "With the guest at Alpha, Charlie full and Bravo empty, the list offers only Bravo. After moving, the row reads 'Seated at Bravo', the current plan has the guest at Bravo, and the other guest at Alpha hasn't moved.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const mover = uniquePersonName(testInfo.workerIndex);
    const stayer = uniquePersonName(testInfo.workerIndex);
    const filler = uniquePersonName(testInfo.workerIndex);
    const moverName = `${mover.firstName} ${mover.lastName}`;
    let planVersionId = "";
    let moverId = "";
    let stayerId = "";
    let alphaId = "";
    let bravoId = "";

    await test.step("Arrange: two guests at Alpha, Charlie full, Bravo empty", async () => {
      moverId = (await weddingData.createGuest(w, mover)).id;
      stayerId = (await weddingData.createGuest(w, stayer)).id;
      const fillerId = (await weddingData.createGuest(w, filler)).id;
      alphaId = (await weddingData.createTable(w, { label: "Alpha", capacity: 4 })).id;
      bravoId = (await weddingData.createTable(w, { label: "Bravo", capacity: 4 })).id;
      const charlieId = (await weddingData.createTable(w, { label: "Charlie", capacity: 1 })).id;
      planVersionId = (await weddingData.generatePlanVersion(w)).id;
      for (const id of [moverId, stayerId, fillerId]) {
        expect((await weddingData.moveGuestAssignment(w, planVersionId, id, alphaId)).status).toBe(200);
      }
      expect((await weddingData.moveGuestAssignment(w, planVersionId, fillerId, charlieId)).status).toBe(200);
    });

    const dayOf = new DayOfTabPage(page);
    await test.step("The guest's Move to list offers only the table with room", async () => {
      await dayOf.goto(w);
      await expect(dayOf.guestStatusText(moverName)).toHaveText("Seated at Alpha");
      expect(await dayOf.moveToChoices(moverName)).toEqual(["Bravo"]);
    });

    await test.step("Moving the guest seats them at Bravo, and nobody else moves", async () => {
      await dayOf.moveGuestTo(moverName, "Bravo");
      await expect(dayOf.noticeText()).toHaveText(`Moved ${moverName} to Bravo.`);
      const detail = await weddingData.getPlanVersionDetail(w, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === moverId)?.tableId).toBe(bravoId);
      expect(detail.assignments.find((a) => a.guestId === stayerId)?.tableId).toBe(alphaId);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-keep-up-and-keep-your-work.newer-plan-shows-up-in-an-open-tab",
    title: "a newer plan made in another browser opens on its own in a Seating plan tab that was already open, with a note, and the old version's undo goes",
    objective:
      "Confirms (TS-189) that with the Seating plan tab open on version 1 -- and a move made there, so Undo is offered -- generating a new plan from a second browser session makes the first tab switch to version 2 within the tab's 4-second check, say 'A newer plan was made — you're now looking at it.', and drop Undo/Redo for the version it left.",
    expectedOutcome:
      "Within 10 seconds the first tab shows the newer-plan note and 'Version 2', and the Undo/Redo row is gone.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:manual-adjustment", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser, page }, testInfo) => {
    const w = managedWedding.id;
    const guestId = (await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex))).id;
    const first = await weddingData.createTable(w, { label: "Table 1", capacity: 4 });
    const second = await weddingData.createTable(w, { label: "Table 2", capacity: 4 });
    const v1 = await weddingData.generatePlanVersion(w);
    const seatedAt = v1.assignments.find((a) => a.guestId === guestId)?.tableId;
    const otherTable = seatedAt === first.id ? second.id : first.id;

    const plan = new PlanTabPage(page);
    await test.step("First tab: version 1 open, with a move made so Undo is offered", async () => {
      await plan.goto(w);
      await expect(plan.openVersionBadge(1)).toBeVisible();
      await plan.showFloorPlanView();
      await plan.tapMoveGuestToTable(guestId, otherTable);
      await expect.poll(() => plan.undoRedoRowVisible()).toBe(true);
    });

    const otherSession = await browser.newContext({ storageState: await context.storageState() });
    try {
      await test.step("Second browser session: generate a new plan", async () => {
        const otherPlan = new PlanTabPage(await otherSession.newPage());
        await otherPlan.goto(w);
        await otherPlan.generate();
        await expect(otherPlan.openVersionBadge(2)).toBeVisible();
      });
    } finally {
      await otherSession.close();
    }

    await test.step("First tab: switches to version 2 on its own, says so, and Undo is gone", async () => {
      await expect(plan.newerPlanNotice()).toBeVisible({ timeout: 10_000 });
      await expect(plan.openVersionBadge(2)).toBeVisible();
      await expect.poll(() => plan.undoRedoRowVisible()).toBe(false);
    });
  },
);
