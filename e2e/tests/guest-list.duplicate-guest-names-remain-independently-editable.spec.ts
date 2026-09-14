/**
 * TS-40 (REQ-GUEST-LIST-MANAGEMENT) — converts AC-021 ("Two guests who share the same name are
 * kept visually distinguishable and never get confused with each other"). Traced against
 * GuestsTab.tsx's row rendering: each guest row shows partyName/tier/side/ageCategory/
 * plusOneNames as a distinguishing subtitle line under the name, plus the guest's own email --
 * so two identically-named guests are told apart by whichever of those differs between them,
 * with no separate "duplicate name" feature needed.
 *
 * This test proves the underlying safety guarantee rather than a specific visual affordance: two
 * guests created with the exact same first and last name, but different partyName and email,
 * remain two fully independent records throughout -- editing one's email and partyName never
 * bleeds onto the other, both are individually addressable and deletable by id, and both keep
 * showing up as separate rows with their own distinguishing data intact. (Matching by name is
 * never how the app identifies a guest for any mutation -- always by id -- which is the actual
 * mechanism that keeps same-named guests from being confused with each other.)
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

interface GuestDetail {
  id: string;
  firstName: string;
  lastName: string;
  partyName: string | null;
  email: string | null;
}

defineQualityTest(
  {
    id: "guest-list.duplicate-guest-names-remain-independently-editable.same-name-two-households",
    title: "two guests sharing the exact same name stay fully independent and distinguishable by their other data",
    objective:
      "Confirms that two guests created with an identical first and last name, but different party names and emails, are never confused with each other: editing one's data doesn't affect the other, both remain independently retrievable and deletable by id, and each keeps showing its own distinguishing partyName/email in the guest list.",
    expectedOutcome:
      "After editing the first same-named guest's email and partyName, the second same-named guest's own email and partyName are unchanged; both appear as two separate entries in the guest list, each showing its own correct partyName; deleting one leaves the other fully intact.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    // Same first AND last name for both -- the whole point of the scenario.
    const sharedName = uniquePersonName(testInfo.workerIndex);
    let idA = "";
    let idB = "";
    const emailA = `guest-a-${testInfo.workerIndex}-${Date.now()}@example.com`;
    const emailB = `guest-b-${testInfo.workerIndex}-${Date.now()}@example.com`;
    const emailARenamed = `guest-a-renamed-${testInfo.workerIndex}-${Date.now()}@example.com`;

    await test.step("Arrange: two guests with the identical name, distinguished only by partyName and email", async () => {
      const a = await weddingData.createGuest(managedWedding.id, {
        ...sharedName,
        partyName: "The Smith Household",
        email: emailA,
      });
      const b = await weddingData.createGuest(managedWedding.id, {
        ...sharedName,
        partyName: "The Jones Household",
        email: emailB,
      });
      idA = a.id;
      idB = b.id;
    });

    await test.step("Act: edit guest A's email and partyName", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/guests/${idA}`, {
        data: { partyName: "The Smith-Renamed Household", email: emailARenamed },
      });
      expect(res.ok()).toBe(true);
    });

    await test.step("Assert: guest B's own data is completely untouched by guest A's edit", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests/${idB}`);
      const { guest } = (await res.json()) as { guest: GuestDetail };
      expect(guest.partyName).toBe("The Jones Household");
      expect(guest.email).toBe(emailB);
    });

    await test.step("Assert: both guests appear as two separate entries in the list, each with the correct name and its own distinguishing partyName", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests`);
      const { guests } = (await res.json()) as { guests: GuestDetail[] };
      const sameNamed = guests.filter(
        (g) => g.firstName === sharedName.firstName && g.lastName === sharedName.lastName,
      );
      expect(sameNamed.length).toBe(2);
      const a = sameNamed.find((g) => g.id === idA)!;
      const b = sameNamed.find((g) => g.id === idB)!;
      expect(a.partyName).toBe("The Smith-Renamed Household");
      expect(a.email).toBe(emailARenamed);
      expect(b.partyName).toBe("The Jones Household");
      expect(b.email).toBe(emailB);
    });

    await test.step("Act: delete guest A", async () => {
      const res = await context.request.delete(`/api/v1/weddings/${managedWedding.id}/guests/${idA}`);
      expect(res.ok()).toBe(true);
    });

    await test.step("Assert: guest B (the identically-named guest) is completely unaffected by guest A's deletion", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests/${idB}`);
      expect(res.ok()).toBe(true);
      const { guest } = (await res.json()) as { guest: GuestDetail };
      expect(guest.partyName).toBe("The Jones Household");
      expect(guest.firstName).toBe(sharedName.firstName);
      expect(guest.lastName).toBe(sharedName.lastName);
    });
  },
);
