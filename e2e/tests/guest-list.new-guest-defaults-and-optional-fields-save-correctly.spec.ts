/**
 * TS-40 (REQ-GUEST-LIST-MANAGEMENT) — converts AC-012 ("A guest added with just a name gets
 * sensible defaults for every other field") and AC-013 ("Optional fields save correctly and
 * don't silently affect anything else"). Both are opposite sides of the same behavior --
 * `createGuestSchema` (packages/shared/src/schemas/guest.ts) -- so they're exercised together:
 * one guest created with only firstName/lastName to prove the default set, one created with
 * every optional field explicitly populated to prove each one is saved as given and doesn't
 * silently affect anything it isn't supposed to.
 *
 * The workbook's "dietary/accessibility notes" for AC-013 is just descriptive content in the
 * single free-text `notes` field -- there's no separate dietary/accessibility-notes field in the
 * schema. The second guest's notes text explicitly mentions an accessibility need in prose to
 * confirm that alone never sets `requiresAccessibleTable`; that field is its own explicit
 * boolean, checked separately.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

interface GuestDetail {
  id: string;
  firstName: string;
  lastName: string;
  partyName: string | null;
  headcount: number;
  tier: string;
  rsvpStatus: string;
  requiresAccessibleTable: boolean;
  isLocked: boolean;
  dayOfAttendance: string;
  notes: string | null;
  side: string;
  ageCategory: string;
  email: string | null;
  plusOneNames: string | null;
}

defineQualityTest(
  {
    id: "guest-list.new-guest-defaults-and-optional-fields-save-correctly.name-only-and-fully-specified",
    title: "a name-only guest gets sensible defaults, and a fully-specified guest saves every optional field correctly",
    objective:
      "Confirms that creating a guest with only a first and last name fills every other field with its documented default, and that creating a guest with every optional field populated saves each one exactly as given without any of them silently affecting another (notably: descriptive notes text never sets Requires Accessible Table on its own).",
    expectedOutcome:
      "The name-only guest has tier OTHER, side BOTH, age category ADULT, RSVP PENDING, attendance ATTENDING, requiresAccessibleTable/isLocked both false, headcount 1, and null partyName/notes/email/plusOneNames. The fully-specified guest has every field saved as given, with requiresAccessibleTable staying false despite accessibility-related text in notes.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, context }, testInfo) => {
    async function getGuest(guestId: string): Promise<GuestDetail> {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests/${guestId}`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { guest: GuestDetail };
      return body.guest;
    }

    await test.step("Act: create a guest with only a first and last name", async () => {
      const name = uniquePersonName(testInfo.workerIndex);
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/guests`, { data: name });
      expect(res.ok()).toBe(true);
      const { guest } = (await res.json()) as { guest: { id: string } };

      const detail = await getGuest(guest.id);
      expect(detail.tier).toBe("OTHER");
      expect(detail.side).toBe("BOTH");
      expect(detail.ageCategory).toBe("ADULT");
      expect(detail.rsvpStatus).toBe("PENDING");
      expect(detail.dayOfAttendance).toBe("ATTENDING");
      expect(detail.requiresAccessibleTable).toBe(false);
      expect(detail.isLocked).toBe(false);
      expect(detail.headcount).toBe(1);
      expect(detail.partyName).toBeNull();
      expect(detail.notes).toBeNull();
      expect(detail.email).toBeNull();
      expect(detail.plusOneNames).toBeNull();
    });

    await test.step("Act: create a guest with every optional field explicitly populated", async () => {
      const name = uniquePersonName(testInfo.workerIndex);
      const input = {
        ...name,
        partyName: "The Fully-Specified Household",
        headcount: 3,
        tier: "VIP",
        rsvpStatus: "CONFIRMED",
        requiresAccessibleTable: false,
        isLocked: true,
        dayOfAttendance: "ATTENDING",
        notes: "Vegetarian; mentions using a wheelchair to get around the venue.",
        side: "GROOM",
        ageCategory: "CHILD",
        email: `fully-specified-${testInfo.workerIndex}-${Date.now()}@example.com`,
        plusOneNames: "Jamie Doe, Baby Doe",
      };
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/guests`, { data: input });
      expect(res.ok()).toBe(true);
      const { guest } = (await res.json()) as { guest: { id: string } };

      const detail = await getGuest(guest.id);
      expect(detail.partyName).toBe(input.partyName);
      expect(detail.headcount).toBe(input.headcount);
      expect(detail.tier).toBe(input.tier);
      expect(detail.rsvpStatus).toBe(input.rsvpStatus);
      // The core AC-013 nuance: descriptive "wheelchair" text in free-text notes never itself
      // sets the structured, separately-checked requiresAccessibleTable flag.
      expect(detail.requiresAccessibleTable).toBe(false);
      expect(detail.isLocked).toBe(true);
      expect(detail.dayOfAttendance).toBe(input.dayOfAttendance);
      expect(detail.notes).toBe(input.notes);
      expect(detail.side).toBe(input.side);
      expect(detail.ageCategory).toBe(input.ageCategory);
      expect(detail.email).toBe(input.email);
      expect(detail.plusOneNames).toBe(input.plusOneNames);
    });
  },
);
