/**
 * TS-118 (REQ-GUEST-LIST-MANAGEMENT) — the guest-row controls the 2026-09-30 coverage audit found
 * untested through the UI: changing a guest's side, setting and correcting their email (including
 * an invalid one, which must not stick), and removing the guest.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "guest-list.side-email-and-remove-through-the-guest-row.side-email-invalid-email-remove",
    title: "a guest's side and email can be changed from their row, an invalid email is refused and put back, and Remove takes the guest off the list",
    objective:
      "Confirms that choosing a side in a guest's row saves it, that typing an email saves it and clearing it removes it, that an invalid email is refused with the validation message and the field shows the saved email again, and that Remove takes the guest off the list and out of the wedding.",
    expectedOutcome:
      "The API reports side BRIDE, then email 'guest@example.invalid', then the 'Not a valid email address' message shows with the field reading the saved email and the API unchanged, then email null after clearing. After Remove the row is gone and the API no longer lists the guest.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const guest = await weddingData.createGuest(w, name);
    const saved = async () => (await weddingData.listGuests(w)).find((g) => g.id === guest.id) as
      | { side?: string; email: string | null }
      | undefined;

    await weddingGuestsPage.goto(w);
    await weddingGuestsPage.openGuestsTab();
    const row = weddingGuestsPage.guestRow(fullName);
    await row.expectVisible();

    await test.step("Choosing a side saves it", async () => {
      await row.setSide("BRIDE");
      await expect.poll(async () => (await saved())?.side).toBe("BRIDE");
    });

    await test.step("An email can be set, an invalid one is refused and put back, and clearing removes it", async () => {
      await row.editEmail("guest@example.invalid");
      await expect.poll(async () => (await saved())?.email).toBe("guest@example.invalid");

      await row.editEmail("not-an-email");
      await expect(weddingGuestsPage.message(/Not a valid email address/)).toBeVisible();
      await expect.poll(() => row.email()).toBe("guest@example.invalid");
      expect((await saved())?.email).toBe("guest@example.invalid");

      await row.editEmail("");
      await expect.poll(async () => (await saved())?.email).toBeNull();
    });

    await test.step("Remove takes the guest off the list", async () => {
      await row.remove();
      await expect(row.locator()).toHaveCount(0);
      await expect.poll(saved).toBeUndefined();
    });
  },
);
