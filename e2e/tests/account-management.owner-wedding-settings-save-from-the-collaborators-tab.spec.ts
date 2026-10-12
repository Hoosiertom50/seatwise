/**
 * TS-118 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — the owner's wedding settings on the Collaborators tab,
 * which the 2026-09-30 coverage audit found untested through the UI: renaming the wedding (and the
 * disallowed-character and blank-name refusals), the two side labels (blank falls back to Bride/Groom), the wedding note,
 * the RSVP cutoff date (and clearing it), and the email-notifications checkbox. Each saves when
 * the field loses focus, and each is checked against the API, not just the screen.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";

interface WeddingSettings {
  name: string;
  sideLabel1: string;
  sideLabel2: string;
  note: string | null;
  rsvpCutoffDate: string | null;
  emailNotificationsEnabled: boolean;
}

defineQualityTest(
  {
    id: "account-management.owner-wedding-settings-save-from-the-collaborators-tab.name-sides-note-cutoff-email",
    title: "the owner can rename the wedding (never to blank), rename its sides, write a note, set and clear an RSVP cutoff, and turn email notifications on and off",
    objective:
      "Confirms that each owner-only setting on the Collaborators tab saves on blur and reaches the server: a new wedding name (with disallowed characters refused with the allowed-characters message, and a blank name refused with 'Wedding name can't be blank.' and the saved name put back), side labels (blank falling back to Bride/Groom), the wedding note, an RSVP cutoff date that can be cleared again, and the email-notifications checkbox both ways.",
    expectedOutcome:
      "The API shows the new name, and after a blank attempt the message shows with the field and API still on the new name. Sides read 'Partner A'/'Partner B', then 'Bride'/'Groom' after blanking both. The note matches. The cutoff reads 2030-06-01, then null after clearing. emailNotificationsEnabled flips and flips back.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const w = managedWedding.id;
    const settings = new CollaboratorsTabPage(page);
    const saved = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as { wedding: WeddingSettings }).wedding;
    await settings.goto(w);

    await test.step("Rename, and a name with disallowed characters or a blank one is refused (the typed name stays to fix, nothing is saved)", async () => {
      const newName = `${managedWedding.name} - renamed`;
      await settings.setAndLeave(settings.weddingNameInput(), newName);
      await expect.poll(async () => (await saved()).name).toBe(newName);

      await settings.setAndLeave(settings.weddingNameInput(), `${newName} (oops)`);
      await expect(settings.message(/^Can only contain letters, numbers, spaces, and common punctuation/)).toBeVisible();
      // TS-199: a refused value stays in the box (with the reason) for the owner to fix; nothing is saved.
      await expect(settings.weddingNameInput()).toHaveValue(`${newName} (oops)`);
      expect((await saved()).name).toBe(newName);

      await settings.setAndLeave(settings.weddingNameInput(), "   ");
      await expect(settings.message("Wedding name can't be blank.")).toBeVisible();
      await expect(settings.weddingNameInput()).toHaveValue(newName);
      expect((await saved()).name).toBe(newName);
    });

    await test.step("Side labels save, and blank ones fall back to Bride and Groom", async () => {
      await settings.sideLabelInput(1).fill("Partner A");
      await settings.setAndLeave(settings.sideLabelInput(2), "Partner B");
      await expect.poll(async () => [(await saved()).sideLabel1, (await saved()).sideLabel2]).toEqual(["Partner A", "Partner B"]);

      await settings.sideLabelInput(1).fill("");
      await settings.setAndLeave(settings.sideLabelInput(2), "");
      await expect.poll(async () => [(await saved()).sideLabel1, (await saved()).sideLabel2]).toEqual(["Bride", "Groom"]);
      await expect(settings.sideLabelInput(1)).toHaveValue("Bride");
    });

    await test.step("The note saves", async () => {
      await settings.setAndLeave(settings.weddingNoteInput(), "Venue wants final numbers 14 days out.");
      await expect.poll(async () => (await saved()).note).toBe("Venue wants final numbers 14 days out.");
    });

    await test.step("An RSVP cutoff can be set and cleared", async () => {
      await settings.setAndLeave(settings.rsvpCutoffInput(), "2030-06-01");
      await expect.poll(async () => (await saved()).rsvpCutoffDate).toBe("2030-06-01");
      await settings.setAndLeave(settings.rsvpCutoffInput(), "");
      await expect.poll(async () => (await saved()).rsvpCutoffDate).toBeNull();
    });

    await test.step("Email notifications can be turned off and on again", async () => {
      const before = (await saved()).emailNotificationsEnabled;
      await settings.emailNotificationsCheckbox().click();
      await expect.poll(async () => (await saved()).emailNotificationsEnabled).toBe(!before);
      await expect(settings.emailNotificationsCheckbox()).toBeChecked({ checked: !before });
      await settings.emailNotificationsCheckbox().click();
      await expect.poll(async () => (await saved()).emailNotificationsEnabled).toBe(before);
    });
  },
);
