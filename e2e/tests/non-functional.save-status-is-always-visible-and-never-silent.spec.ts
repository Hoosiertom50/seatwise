/**
 * TS-93 (REQ-NON-FUNCTIONAL, REQ-GUEST-LIST-MANAGEMENT) — autosave must be visibly confirmed, and a
 * save that doesn't land must never fail silently.
 *
 * Every edit in the app goes through apps/web/src/lib/api-client.ts, which now feeds one app-wide
 * save status that the wedding page shows in its header (SaveStatusIndicator). This walks that
 * indicator through every state using one real inline edit (a guest's RSVP status on the Guests
 * tab) and deterministic failure injection (e2e/support/networkFaults.ts):
 *
 * - a slow save shows "Saving…", then "All changes saved";
 * - a server-refused save shows "Not saved: <why>" until dismissed;
 * - a save whose connection keeps dropping is retried automatically (3 attempts), then shows the
 *   connection message -- the ticket's explicit "save fails while offline or mid-request" case;
 * - a one-off connection blip is recovered by the automatic retry and ends "All changes saved",
 *   with the change genuinely persisted;
 * - going offline shows the offline state, and coming back clears it.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniquePersonName } from "../data/ids.js";
import { delayRequests, failRequests } from "../support/networkFaults.js";

interface GuestListRow {
  id: string;
  rsvpStatus: string;
}

defineQualityTest(
  {
    id: "non-functional.save-status-is-always-visible-and-never-silent.saving-saved-failed-retried-offline",
    title: "the wedding page's save status shows saving, saved, not-saved (server and connection failures), automatic retry recovery, and offline — never a silent failure",
    objective:
      "Confirms an inline edit's save is visible while in flight and once confirmed; that a server-refused save and a save whose connection drops are both reported as not saved with the reason (the latter only after automatic retries); that a single dropped connection is recovered by retry and persists; and that the indicator reports offline and recovers.",
    expectedOutcome:
      "Slow save: 'Saving…' then 'All changes saved'. Injected 500: 'Not saved: <message>', and nothing at all once dismissed (TS-206: never 'All changes saved' for a change that wasn't). Dropped connection: 3 attempts then 'Not saved: Couldn't reach Seatwise…'. One-off drop: 2 attempts, 'All changes saved', and the server holds the new value. Offline: the offline message, gone once back online.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:non-functional", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context, page }, testInfo) => {
    const detailPage = new WeddingDetailPage(page);
    const name = uniquePersonName(testInfo.workerIndex);
    const guestUrl = (id: string) => `**/api/v1/weddings/${managedWedding.id}/guests/${id}`;
    let guestId = "";

    await test.step("Arrange: a guest on the Guests tab, with nothing saved yet", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, name);
      guestId = guest.id;
      await weddingGuestsPage.goto(managedWedding.id);
      await weddingGuestsPage.openGuestsTab();
      await weddingGuestsPage.guestRow(`${name.firstName} ${name.lastName}`).expectVisible();
      await expect(detailPage.saveStatus()).toHaveText("");
    });
    const row = () => weddingGuestsPage.guestRow(`${name.firstName} ${name.lastName}`);

    await test.step("Act + Assert: a slow save shows Saving…, then All changes saved", async () => {
      const slow = await delayRequests(page, guestUrl(guestId), "PATCH", 1500);
      await row().setRsvpStatus("CONFIRMED");
      await expect(detailPage.saveStatus()).toHaveText("Saving…");
      await expect(detailPage.saveStatus()).toHaveText("All changes saved");
      expect(slow.hits).toBe(1);
      await slow.clear();
    });

    await test.step("Act + Assert: a save the server refuses is reported as not saved, until dismissed", async () => {
      const fault = await failRequests(page, guestUrl(guestId), "PATCH", {
        status: 500,
        error: "Simulated outage while saving the guest.",
      });
      await row().setRsvpStatus("DECLINED");
      await expect(detailPage.saveStatus()).toContainText("Not saved: Simulated outage while saving the guest.");
      expect(fault.hits).toBe(1); // an HTTP error is an answer, never retried
      await fault.clear();
      // TS-206: once dismissed the header shows nothing -- it used to say "All changes saved",
      // though the change that failed was never saved.
      await detailPage.dismissSaveError();
      await expect(detailPage.saveStatus()).toHaveText("");
    });

    await test.step("Act + Assert: a save whose connection keeps dropping is retried, then reported as not saved", async () => {
      const fault = await failRequests(page, guestUrl(guestId), "PATCH", "network");
      await row().setRsvpStatus("DECLINED");
      await expect(detailPage.saveStatus()).toContainText("Not saved: Couldn't reach Seatwise", { timeout: 10_000 });
      expect(fault.hits).toBe(3); // the first attempt plus both automatic retries
      await fault.clear();
    });

    await test.step("Act + Assert: a one-off dropped connection is recovered by the retry and really saves", async () => {
      const blip = await failRequests(page, guestUrl(guestId), "PATCH", "network", 1);
      await row().setRsvpStatus("DECLINED");
      await expect(detailPage.saveStatus()).toHaveText("All changes saved", { timeout: 10_000 });
      expect(blip.hits).toBe(1);
      await blip.clear();

      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests`);
      const { guests } = (await res.json()) as { guests: GuestListRow[] };
      expect(guests.find((g) => g.id === guestId)!.rsvpStatus).toBe("DECLINED");
    });

    await test.step("Act + Assert: going offline is shown, and coming back clears it", async () => {
      await context.setOffline(true);
      await expect(detailPage.saveStatus()).toHaveText("Offline — changes can't be saved until you reconnect");
      await context.setOffline(false);
      await expect(detailPage.saveStatus()).toHaveText("All changes saved");
    });
  },
);
