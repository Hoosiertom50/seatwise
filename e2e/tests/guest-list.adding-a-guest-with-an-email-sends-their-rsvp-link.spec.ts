/**
 * TS-143 (REQ-CLIENT-RSVP-COLLECTION) — Tom's decision (2026-10-02): adding a guest with an email
 * sends them their RSVP link straight away, with no checkbox; so does giving an existing guest
 * their first email. TS-154 (decision #3): correcting an address that's already there replaces
 * the link (the old one may have gone to the wrong person) and emails the corrected address. The CSV
 * import has no email column at all, so a big import can never email everyone by surprise.
 *
 * No real email is sent: locally and in CI emails are only logged, which the app counts as sent.
 * The RSVP link's existence is checked in the test database.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { guestRsvpToken } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "guest-list.adding-a-guest-with-an-email-sends-their-rsvp-link.add-first-email-change-none",
    title: "adding a guest with an email emails their RSVP link right away, so does giving a guest their first email, and correcting an existing email sends a fresh link",
    objective:
      "Confirms that adding a guest with an email through the Add a guest form says 'Emailed RSVP link to <email>' on their row and creates their RSVP link; that a guest added without an email gets no link and no message; that typing a first email into that guest's row sends their link; and that correcting an email that's already there replaces the link and emails the new address.",
    expectedOutcome:
      "The first guest's row shows 'Emailed RSVP link to <email>' and they have an RSVP token. The second guest has no token until an email is typed into their row, which then shows the same message and creates a token. Correcting that email via the API reports it was emailed and replaces the token.",
    requirementIds: ["REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context }, testInfo) => {
    const w = managedWedding.id;
    const withEmail = uniquePersonName(testInfo.workerIndex);
    const withoutEmail = uniquePersonName(testInfo.workerIndex);
    // Test guests all share the first name "Playwright" -- the last name is what tells them apart.
    const idOf = async (lastName: string) => (await weddingData.listGuests(w)).find((g) => g.lastName === lastName)!.id;
    const address = (label: string) => `pw-guest-${label}-${Date.now()}@example.invalid`;

    await weddingGuestsPage.goto(w);
    await weddingGuestsPage.openGuestsTab();

    await test.step("A guest added with an email is sent their RSVP link straight away", async () => {
      const email = address("added");
      await weddingGuestsPage.addGuest({ ...withEmail, email });
      const row = weddingGuestsPage.guestRow(`${withEmail.firstName} ${withEmail.lastName}`);
      await expect(row.autoRsvpResult()).toHaveText(`Emailed RSVP link to ${email}`);
      expect(await guestRsvpToken(await idOf(withEmail.lastName))).toMatch(/^[0-9a-f]{64}$/);
    });

    let laterId = "";
    let firstToken: string | null = null;
    await test.step("A guest added without an email gets nothing, until they're given their first email", async () => {
      await weddingGuestsPage.addGuest(withoutEmail);
      const row = weddingGuestsPage.guestRow(`${withoutEmail.firstName} ${withoutEmail.lastName}`);
      await row.expectVisible();
      laterId = await idOf(withoutEmail.lastName);
      expect(await guestRsvpToken(laterId)).toBeNull();
      await expect(row.autoRsvpResult()).toHaveCount(0);

      const email = address("later");
      await row.editEmail(email);
      await expect(row.autoRsvpResult()).toHaveText(`Emailed RSVP link to ${email}`);
      firstToken = await guestRsvpToken(laterId);
      expect(firstToken).toMatch(/^[0-9a-f]{64}$/);
    });

    // TS-154 (Tom's decision #3): correcting an address replaces the link and emails the new one.
    await test.step("Changing an email that's already there sends a fresh link to the new address", async () => {
      const guest = (await weddingData.listGuests(w)).find((g) => g.id === laterId)!;
      const res = await context.request.patch(`/api/v1/weddings/${w}/guests/${laterId}`, {
        data: { email: address("changed"), expectedRevision: (guest as unknown as { revision: number }).revision },
      });
      expect(res.ok()).toBe(true);
      expect(((await res.json()) as { rsvpEmail?: { emailed: boolean } }).rsvpEmail?.emailed).toBe(true);
      expect(await guestRsvpToken(laterId)).not.toBe(firstToken);
    });
  },
);
