/**
 * TS-209 / TS-210 / TS-211 (review 7) -- what the planner is told matches what really happened:
 * - Deleting a guest someone else already deleted leaves them deleted (it used to put them back
 *   with "Couldn't delete that guest").
 * - Accepting an invite a second time (a double click, or a retry whose first answer was lost)
 *   lands on the wedding, not "This invite is no longer valid".
 * - An import whose answer was lost, confirmed again, doesn't add every new guest twice: the
 *   screen reloads the list and asks to check it, and the second Confirm gets the first answer.
 * - A guest file with one stray byte flags just that cell (with the UTF-8 mark), or is refused
 *   with a clear message (without it) -- it used to garble every accented letter and save them.
 * - The approved plan's Export says when attending guests aren't seated, and a failed export
 *   (the plan un-approved in another tab, a server error) is said on the page, not raw text.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { inviteToken } from "../support/testDatabase.js";
import { failRequests, loseResponses } from "../support/networkFaults.js";
import { InviteAcceptPage } from "../pages/InviteAcceptPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";

defineQualityTest(
  {
    id: "cross-cutting.saved-changes-and-exports-say-what-really-happened.delete-of-a-gone-guest-stays-deleted",
    title: "deleting a guest someone else already deleted leaves them deleted, with no error",
    objective:
      "Opens the Guests tab, starts removing a guest, deletes that guest through the API meanwhile (as another tab would), then confirms the removal on screen. Confirms the guest's row goes and stays gone, no 'Couldn't delete' message appears, and the guest list (API) no longer has them.",
    expectedOutcome:
      "After 'Yes, ...' the guest's row is gone (and still gone after a reload), no text 'Couldn't delete that guest.' is shown, and GET guests doesn't include the guest.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const guest = await weddingData.createGuest(w, name);
    const guests = new WeddingGuestsPage(page);
    const row = guests.guestRow(`${name.firstName} ${name.lastName}`);

    await test.step("The guest is deleted elsewhere while the remove question is open", async () => {
      await guests.goto(w);
      await expect(row.locator()).toBeVisible();
      await row.startRemove();
      await weddingData.deleteGuest(w, guest.id);
    });

    await test.step("Confirming the remove leaves them deleted, with no error", async () => {
      await row.removeConfirmation().confirm();
      await expect(row.locator()).toHaveCount(0);
      await expect(guests.message("Couldn't delete that guest.")).toHaveCount(0);
      await page.reload();
      await expect(guests.guestListHeading()).toBeVisible();
      await expect(row.locator()).toHaveCount(0);
      expect((await weddingData.listGuests(w)).some((g) => g.id === guest.id)).toBe(false);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.saved-changes-and-exports-say-what-really-happened.second-invite-accept-lands-on-the-wedding",
    title: "accepting an invite that already went through (a double click, or a lost answer) lands on the wedding",
    objective:
      "Opens a pending invite as the invited (confirmed) account, accepts it through the API meanwhile (as a first click whose answer was lost would), then presses Accept invite on the page. Confirms the page goes to the wedding, and that accepting again through the API answers 200 with the wedding's id.",
    expectedOutcome:
      "The page lands on /weddings/<id> with no 'no longer valid' error, and a further POST .../accept returns 200 with weddingId equal to the wedding's id. The person is a collaborator once.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, browser }, testInfo) => {
    const w = managedWedding.id;
    const invitee = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "invitee");
    try {
      const sent = await weddingData.createInvite(w, invitee.email, "EDIT");
      expect(sent.status).toBe(201);
      const token = await inviteToken(sent.body.invite!.id);
      const inviteePage = await invitee.context.newPage();
      const invitePage = new InviteAcceptPage(inviteePage);

      await test.step("The first accept goes through while the page still shows the invite", async () => {
        await invitePage.goto(token);
        await expect(invitePage.acceptButton()).toBeVisible();
        const first = await invitee.context.request.post(`/api/v1/invites/${token}/accept`, { data: {} });
        expect(first.status()).toBe(200);
      });

      await test.step("Pressing Accept again lands on the wedding", async () => {
        await invitePage.accept();
        await inviteePage.waitForURL(`**/weddings/${w}`);
        const again = await invitee.context.request.post(`/api/v1/invites/${token}/accept`, { data: {} });
        expect(again.status()).toBe(200);
        expect(((await again.json()) as { weddingId: string }).weddingId).toBe(w);
        const collaborators = await weddingData.listCollaborators(w);
        expect(collaborators.filter((c) => c.userEmail === invitee.email)).toHaveLength(1);
      });
    } finally {
      await invitee.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.saved-changes-and-exports-say-what-really-happened.import-retry-does-not-duplicate",
    title: "an import whose answer was lost, confirmed again, doesn't add its guests twice",
    objective:
      "Previews a file of two new guests on the Guests tab, lets the first Confirm reach the server but drops its answer, and confirms the page reloads the list and asks to check it before importing again; then presses Confirm again and confirms the import completes with each guest in the wedding exactly once.",
    expectedOutcome:
      "After the lost answer an alert containing 'Check the list before importing again' shows and both guests are already in the list. The second Confirm shows 'Import complete:' and GET guests has exactly one of each guest.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const a = uniquePersonName(testInfo.workerIndex);
    const b = uniquePersonName(testInfo.workerIndex);
    const guests = new WeddingGuestsPage(page);

    await test.step("The first Confirm is saved, but its answer is lost", async () => {
      await guests.goto(w);
      await guests.importGuestsFromCsvAndPreview(`firstName,lastName\n${a.firstName},${a.lastName}\n${b.firstName},${b.lastName}\n`);
      const lost = await loseResponses(page, "**/guests/import/commit", "POST", 1);
      await guests.confirmImportButtonLocator().click();
      await expect(guests.importError(/Check the list before importing again/)).toBeVisible();
      expect(lost.hits).toBe(1);
      await expect(guests.guestRow(`${a.firstName} ${a.lastName}`).locator()).toBeVisible();
    });

    await test.step("Confirming again gets the first answer, and nobody is added twice", async () => {
      await guests.confirmImport();
      const listed = await weddingData.listGuests(w);
      for (const p of [a, b]) {
        expect(listed.filter((g) => g.firstName === p.firstName && g.lastName === p.lastName)).toHaveLength(1);
      }
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.saved-changes-and-exports-say-what-really-happened.stray-byte-file-flagged",
    title: "a guest file with one stray byte flags just that cell, or is refused, instead of garbling every accented name",
    objective:
      "Uploads, on the Guests tab, a UTF-8 file with the byte-order mark and one stray byte after 'Lee', and confirms the preview reads 'Zoë Núñez' correctly and shows only the stray-byte row as an error (couldn't be read); then uploads the same file without the byte-order mark and confirms it is refused with the 'save it as CSV UTF-8' message.",
    expectedOutcome:
      "With the mark: the preview has a row for 'Zoë Núñez' and row 1 says the Last name has characters that couldn't be read; the summary shows 1 with errors. Without the mark: an alert saying part of the file is in a different text format and to save it as 'CSV UTF-8', and no column mapping.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, page }) => {
    const guests = new WeddingGuestsPage(page);
    const body = (withBom: boolean) => {
      const text = Buffer.from("First name,Last name,Notes\r\nJesús,Lee", "utf-8");
      const rest = Buffer.from(",Vegan entrée\r\nZoë,Núñez,ok\r\n", "utf-8");
      return Buffer.concat([withBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), text, Buffer.from([0xe9]), rest]);
    };

    await test.step("With the UTF-8 mark: only the stray byte's cell is flagged", async () => {
      await guests.goto(managedWedding.id);
      await guests.importGuestsFileBytesAndPreview(body(true));
      await expect(guests.importPreviewRow("Zoë Núñez")).toBeVisible();
      await expect(guests.importPreviewRowNumber(1)).toContainText("couldn't be read");
      await expect(guests.importPreviewErrorCountText()).toBeVisible();
      await expect(guests.importPreviewSummary()).toContainText("1 new");
      await guests.cancelImport();
    });

    await test.step("Without the mark: the file is refused with a clear message", async () => {
      await guests.chooseImportFileBytes(body(false));
      await expect(guests.importError(/different text format/)).toBeVisible();
      await expect(guests.importError(/CSV UTF-8/)).toBeVisible();
      await expect(guests.importMappingHeading()).toHaveCount(0);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.saved-changes-and-exports-say-what-really-happened.export-warns-and-fails-inline",
    title: "Export says when attending guests aren't seated, still lists them, and a failed export is said on the page",
    objective:
      "Approves a complete plan, then adds an attending guest (unseated). Confirms the Seating plan tab's Export shows the 'aren't seated' warning, the lookup-list PDF still exports (200, a real PDF), and the lookup list opens in a new tab as a file. Then un-approves the plan through the API (as another tab would) and confirms pressing Seating chart (PDF) shows the server's reason inline, leaves no tab of raw text open, and that a failed CSV export on the Guests tab is said inline with no download.",
    expectedOutcome:
      "The warning starts '1 attending guest isn't seated'. GET export/lookup returns 200 application/pdf starting '%PDF-'. The lookup button opens a tab whose URL starts with 'blob:'. After un-approving, an alert containing \"isn't Approved yet\" shows next to the buttons and any tab opened for it is closed. On the Guests tab a failed export shows the alert 'Something went wrong' and no download starts.",
    requirementIds: ["REQ-EXPORT-PRINT-RESTORE"],
    tags: ["@mutating", "@feature:export", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    const w = managedWedding.id;
    let planVersionId = "";

    await test.step("Arrange: an approved, complete plan, then a new attending guest", async () => {
      await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      await weddingData.quickCreateTables(w, { count: 1, capacity: 8 });
      const plan = await weddingData.generatePlanVersion(w);
      planVersionId = plan.id;
      expect((await weddingData.setPlanVersionStatus(w, plan.id, "APPROVED")).status).toBe(200);
      await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    });

    const plan = new PlanTabPage(page);
    await test.step("The Export box warns, and the PDF still exports", async () => {
      await plan.goto(w);
      await expect(plan.exportUnseatedWarning()).toContainText("1 attending guest isn't seated");
      const res = await context.request.get(`/api/v1/weddings/${w}/plan-versions/${planVersionId}/export/lookup?tz=America/New_York`);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("application/pdf");
      expect((await res.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
      const [tab] = await Promise.all([page.waitForEvent("popup"), plan.exportButton("Guest lookup list (PDF)").click()]);
      await expect.poll(() => tab.url(), { timeout: 10_000 }).toMatch(/^blob:/);
      await tab.close();
    });

    await test.step("Un-approved in another tab: the export says why, on the page", async () => {
      expect((await weddingData.setPlanVersionStatus(w, planVersionId, "DRAFT")).status).toBe(200);
      const popup = page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null);
      await plan.exportButton("Seating chart (PDF)").click();
      await expect(plan.exportError(/isn't Approved yet/)).toBeVisible();
      const opened = await popup;
      if (opened) await expect.poll(() => opened.isClosed()).toBe(true);
    });

    await test.step("A failed CSV export is said inline, with no download", async () => {
      const guests = new WeddingGuestsPage(page);
      await guests.goto(w);
      const fault = await failRequests(page, "**/guests/export", "GET", { status: 500, error: "Something went wrong" });
      let downloaded = false;
      page.on("download", () => (downloaded = true));
      await guests.exportCsvLink().click();
      await expect(guests.exportCsvError("Something went wrong")).toBeVisible();
      expect(fault.hits).toBe(1);
      expect(downloaded).toBe(false);
      await fault.clear();
    });
  },
);
