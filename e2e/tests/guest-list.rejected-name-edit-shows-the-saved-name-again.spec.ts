/**
 * TS-108 (REQ-GUEST-LIST-MANAGEMENT) — an inline guest-name edit that doesn't save must never leave
 * the rejected text sitting in the input.
 *
 * The Guests tab's name inputs are uncontrolled (`defaultValue`), and React never pushes a changed
 * `defaultValue` into an input that's already mounted. Before TS-108, every rejection path only
 * restored React state, so the input kept showing whatever the user typed: after a failed save
 * (the planner reasonably assumes the rename worked), after a blank name, and after a 409 (the
 * other collaborator's name never appeared). All three are exercised here through the real UI.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { failRequests } from "../support/networkFaults.js";

interface GuestListRow {
  id: string;
  firstName: string;
}

defineQualityTest(
  {
    id: "guest-list.rejected-name-edit-shows-the-saved-name-again.failure-blank-and-conflict",
    title: "a guest-name edit that fails, is blank, or loses a conflict puts the saved name back in the input",
    objective:
      "Confirms the inline first-name input on the Guests tab never keeps text that wasn't saved: after a server error it shows the last saved name (with the error visible and nothing persisted), after blanking the field it shows the saved name again, and after losing a revision conflict it shows the other collaborator's name.",
    expectedOutcome:
      "After the injected 500 the input reads the original first name, the error is shown, and the server still has the original. After a blank edit the input reads the original with the blank-name error shown. After the conflicting edit the input reads the other collaborator's name.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context, page }, testInfo) => {
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    let guestId = "";

    await test.step("Arrange: a guest on the Guests tab", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, name);
      guestId = guest.id;
      await weddingGuestsPage.goto(managedWedding.id);
      await weddingGuestsPage.openGuestsTab();
      await weddingGuestsPage.guestRow(fullName).expectVisible();
    });

    await test.step("Act + Assert: a rename the server refuses puts the saved name back and says so", async () => {
      const fault = await failRequests(page, `**/api/v1/weddings/${managedWedding.id}/guests/${guestId}`, "PATCH", {
        status: 500,
        error: "Simulated outage while saving the guest.",
      });
      const row = weddingGuestsPage.guestRow(fullName);
      await row.editFirstName("Renamed");
      await expect(weddingGuestsPage.message("Simulated outage while saving the guest.")).toBeVisible();
      expect(fault.hits).toBe(1);
      await expect.poll(() => row.firstName()).toBe(name.firstName);
      await fault.clear();

      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests`);
      const { guests } = (await res.json()) as { guests: GuestListRow[] };
      expect(guests.find((g) => g.id === guestId)!.firstName).toBe(name.firstName);
    });

    await test.step("Act + Assert: blanking the name puts the saved name back", async () => {
      const row = weddingGuestsPage.guestRow(fullName);
      await row.editFirstName("");
      await expect(weddingGuestsPage.message("First name can't be blank.")).toBeVisible();
      await expect.poll(() => row.firstName()).toBe(name.firstName);
    });

    await test.step("Act + Assert: a rename that loses a revision conflict shows the other collaborator's name", async () => {
      // Another collaborator's rename lands first, bumping the revision this page last loaded.
      const theirs = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/guests/${guestId}`, {
        data: { firstName: "Theirs" },
      });
      expect(theirs.ok()).toBe(true);

      await weddingGuestsPage.guestRow(fullName).editFirstName("Mine");
      await expect(weddingGuestsPage.message(/was just edited elsewhere/)).toBeVisible();
      await expect.poll(() => weddingGuestsPage.guestRow(`Theirs ${name.lastName}`).firstName()).toBe("Theirs");
    });
  },
);
