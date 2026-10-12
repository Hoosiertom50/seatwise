/**
 * TS-129 (REQ-GUEST-LIST-MANAGEMENT) — a guest's private notes (dietary, accessibility, anything
 * the planning team should know) can be entered and read in the app itself. Before this, the
 * field existed and was encrypted at rest, but the only ways in and out were a CSV import and the
 * CSV export.
 *
 * Notes are entered in "Add a guest" -> More details, shown and edited inline in the guest's row
 * (saved on blur, with the usual stale-edit refusal and TS-108's put-the-saved-text-back), shown
 * hidden from View collaborators (TS-154), and carried by the owner's export.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { uniquePersonName } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

defineQualityTest(
  {
    id: "guest-list.private-guest-notes-can-be-added-edited-and-read.add-edit-stale-view-export",
    title: "a guest's private notes can be added with the guest, edited inline, are refused when stale, are hidden from View users, and appear in the owner's export",
    objective:
      "Confirms the add-guest form's Notes field saves a note that then shows in the guest's row, that an inline edit persists across a reload and that emptying it clears the note, that an edit based on a stale guest is refused with a message and the textarea shows the other change, that a View collaborator sees neither the note nor an editor, and that the CSV export carries the note.",
    expectedOutcome:
      "The new row's notes read 'Vegetarian, nut allergy' and the API agrees. After the edit and a reload they read 'Vegan; uses a wheelchair'; after emptying them the API has null. After the conflicting edit the 'changed since you loaded it' message shows and the textarea reads 'Theirs'. The View user sees no note and no notes textarea. The export contains 'Theirs' in that guest's row.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context, browser }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const notesNow = async () => (await weddingData.listGuests(w)).find((g) => g.firstName === name.firstName)?.notes;

    await weddingGuestsPage.goto(w);
    await weddingGuestsPage.openGuestsTab();

    await test.step("A note entered with a new guest shows in their row", async () => {
      await weddingGuestsPage.addGuest({ ...name, notes: "Vegetarian, nut allergy" });
      const row = weddingGuestsPage.guestRow(fullName);
      await row.expectVisible();
      await expect.poll(() => row.notes()).toBe("Vegetarian, nut allergy");
      expect(await notesNow()).toBe("Vegetarian, nut allergy");
    });

    await test.step("An inline edit persists across a reload, and emptying the note clears it", async () => {
      await weddingGuestsPage.guestRow(fullName).editNotes("Vegan; uses a wheelchair");
      await expect.poll(notesNow).toBe("Vegan; uses a wheelchair");
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      await expect.poll(() => weddingGuestsPage.guestRow(fullName).notes()).toBe("Vegan; uses a wheelchair");

      await weddingGuestsPage.guestRow(fullName).editNotes("");
      await expect.poll(notesNow).toBeNull();
    });

    await test.step("An edit based on a stale guest is refused, and the other change is shown", async () => {
      const guest = (await weddingData.listGuests(w)).find((g) => g.firstName === name.firstName)!;
      const theirs = await context.request.patch(`/api/v1/weddings/${w}/guests/${guest.id}`, { data: { notes: "Theirs" } });
      expect(theirs.ok()).toBe(true);

      await weddingGuestsPage.guestRow(fullName).editNotes("Mine");
      await expect(weddingGuestsPage.message(/changed since you loaded it .*— showing the latest/)).toBeVisible();
      await expect.poll(() => weddingGuestsPage.guestRow(fullName).notes()).toBe("Theirs");
      expect(await notesNow()).toBe("Theirs");
    });

    // TS-154 (Tom's decision #1): notes are for the owner and Edit collaborators only.
    await test.step("A View collaborator doesn't see the note at all", async () => {
      const viewer = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "viewer");
      try {
        await weddingData.addCollaborator(w, viewer.email, "VIEW");
        const viewerTab = new WeddingGuestsPage(await viewer.context.newPage());
        await viewerTab.goto(w);
        await viewerTab.openGuestsTab();
        const row = viewerTab.readOnlyGuestRow(fullName);
        await expect(row.readOnlyNotes()).toHaveCount(0);
        await expect(row.notesEditor()).toHaveCount(0);
        await expect(viewerTab.message("Theirs")).toHaveCount(0);
      } finally {
        await viewer.context.close();
      }
    });

    await test.step("The export carries the note", async () => {
      const res = await context.request.get(`/api/v1/weddings/${w}/guests/export`);
      expect(res.ok()).toBe(true);
      const line = (await res.text()).split(/\r?\n/).find((l) => l.includes(name.firstName));
      expect(line).toContain("Theirs");
    });
  },
);
