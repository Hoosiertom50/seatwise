/**
 * TS-117 / TS-125 (REQ-CLIENT-RSVP-COLLECTION, REQ-GUEST-LIST-MANAGEMENT) — two guest-list paths the
 * coverage audit found untested:
 *
 * 1. "New link" on a guest row issues a fresh RSVP link and must kill the old one -- that's the
 *    whole point of it (a link sent to the wrong person, or forwarded around). For a guest with an
 *    email on file the row says it was emailed to them.
 * 2. The guest CSV export must carry exactly what the guest list holds -- including the encrypted
 *    notes, decrypted for the planner -- and must never hand a spreadsheet a live formula. The
 *    "Guest's RSVP note" column is typed by anyone holding a public RSVP link, so a note like
 *    `=HYPERLINK(...)` is written as `'=HYPERLINK(...)` (TS-125), and re-importing the exported
 *    file leaves every guest exactly as they were.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";

const PLANTED_NOTE = '=HYPERLINK("https://phish.example","Click to confirm your seat")';

defineQualityTest(
  {
    id: "guest-list.rsvp-new-link-and-csv-export-are-safe-and-faithful.new-link-kills-old-export-neutralises-formulas",
    title: "a guest's New RSVP link kills the old one and says it was emailed, and the guest CSV export matches the list, never carries a live formula, and re-imports unchanged",
    objective:
      "Confirms that 'New link' on a guest row issues a new RSVP token, reports it was emailed to the guest's address, and the old link then reads as not found and refuses a submission while the new one works; and that the guest CSV export matches the guest list (including decrypted notes), writes a formula-looking RSVP note and planner note with a leading apostrophe while leaving ordinary text alone, and re-imports by Guest ID without changing anything.",
    expectedOutcome:
      "The row shows 'emailed to <address>'. The old token reads as NOT_FOUND and submitting to it returns 404; the new token reads as OPEN. The export's rows match each guest's ID, names and notes; the planted RSVP note and '=1+1' planner note appear as '\\'=…' and '\\'=1+1', the plain note unchanged. Committing the exported file as an update import succeeds and every guest's first name, last name and notes are identical afterwards.",
    requirementIds: ["REQ-CLIENT-RSVP-COLLECTION", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context, playwright }, testInfo) => {
    const base = `/api/v1/weddings/${managedWedding.id}`;
    const emailName = uniquePersonName(testInfo.workerIndex);
    const email = `pw-guest-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
    const withEmail = await weddingData.createGuest(managedWedding.id, { ...emailName, email, notes: "Vegetarian" });
    const plannerFormula = await weddingData.createGuest(managedWedding.id, { ...uniquePersonName(testInfo.workerIndex), notes: "=1+1" });
    const tokenOf = async (guestId: string) => {
      const res = await context.request.post(`${base}/guests/${guestId}/rsvp-link`, { data: { regenerate: false } });
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { rsvp: { url: string } }).rsvp.url.split("/rsvp/")[1];
    };
    // The public RSVP link needs no sign-in -- use a context with no cookies, as a guest would.
    // Its own made-up network address, so the RSVP link's per-address rate limit (TS-98) is never
    // shared with any other test.
    const publicRequest = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${testInfo.workerIndex + 1}-${uniqueToken(testInfo.workerIndex)}` },
    });

    try {
      const oldToken = await tokenOf(withEmail.id);

      await test.step("'New link' says it was emailed, and the old link stops working while the new one works", async () => {
        await weddingGuestsPage.goto(managedWedding.id);
        await weddingGuestsPage.openGuestsTab();
        const row = weddingGuestsPage.guestRow(`${emailName.firstName} ${emailName.lastName}`);
        await row.requestNewRsvpLink();
        await expect(row.rsvpLinkResult()).toContainText(`mailed to ${email}`);

        const newToken = await tokenOf(withEmail.id);
        expect(newToken).not.toBe(oldToken);
        // Like the invite page, an unknown RSVP link reads as 200 { status: "NOT_FOUND" } -- it
        // reveals nothing -- and submitting to it is refused outright.
        const rsvpStatus = async (token: string) => ((await (await publicRequest.get(`/api/v1/rsvp/${token}`)).json()) as { rsvp: { status: string } }).rsvp.status;
        expect(await rsvpStatus(oldToken)).toBe("NOT_FOUND");
        expect((await publicRequest.post(`/api/v1/rsvp/${oldToken}`, { data: { rsvpStatus: "CONFIRMED" } })).status()).toBe(404);
        expect(await rsvpStatus(newToken)).toBe("OPEN");
      });

      await test.step("Anyone with the guest's link plants a formula-looking RSVP note", async () => {
        const res = await publicRequest.post(`/api/v1/rsvp/${await tokenOf(withEmail.id)}`, {
          data: { rsvpStatus: "CONFIRMED", notes: PLANTED_NOTE },
        });
        expect(res.ok()).toBe(true);
      });

      let exported = "";
      await test.step("The export matches the list and neutralises formula-looking cells only", async () => {
        const res = await context.request.get(`${base}/guests/export`);
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("text/csv");
        exported = await res.text();

        // The raw file, as a spreadsheet would read it. Test names are plain letters and hyphens,
        // so each guest's row begins "<id>,<first>,<last>,".
        const lines = exported.trim().split("\r\n");
        const rowFor = (guestId: string) => lines.find((line) => line.startsWith(`${guestId},`));
        const guests = await weddingData.listGuests(managedWedding.id);
        expect(lines).toHaveLength(guests.length + 1);
        for (const g of guests) expect(rowFor(g.id), g.id).toMatch(new RegExp(`^${g.id},${g.firstName},${g.lastName},`));

        expect(rowFor(withEmail.id)).toContain(",Vegetarian,");
        expect(rowFor(withEmail.id)!.endsWith(`,"'${PLANTED_NOTE.replace(/"/g, '""')}"`)).toBe(true);
        expect(rowFor(plannerFormula.id)).toContain(",'=1+1,");
      });

      await test.step("Re-importing the exported file by Guest ID changes nothing", async () => {
        const before = (await weddingData.listGuests(managedWedding.id)).map((g) => ({ id: g.id, firstName: g.firstName, lastName: g.lastName, notes: g.notes ?? null }));
        const commit = await context.request.post(`${base}/guests/import/commit`, {
          data: {
            csv: exported,
            mapping: { guestId: "Guest ID", firstName: "First name", lastName: "Last name", notes: "Notes" },
          },
        });
        expect(commit.ok(), await commit.text()).toBe(true);
        const after = (await weddingData.listGuests(managedWedding.id)).map((g) => ({ id: g.id, firstName: g.firstName, lastName: g.lastName, notes: g.notes ?? null }));
        expect(after).toEqual(before);
        expect(after.find((g) => g.id === plannerFormula.id)!.notes).toBe("=1+1");
      });
    } finally {
      await publicRequest.dispose();
    }
  },
);
