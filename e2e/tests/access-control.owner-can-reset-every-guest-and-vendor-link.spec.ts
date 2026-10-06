/**
 * TS-179 (REQ-ACCESS-CONTROL) — Tom's decision, 2026-10-06: guest RSVP links and vendor links a
 * collaborator copied keep working after their access is removed or lowered (they aren't tied to
 * the person), so the owner gets "Reset all guest and vendor links" on the Collaborators tab. It
 * gives every link a new address -- the old ones stop working straight away -- and emails nobody.
 * The Remove confirmation and the note after lowering someone's access both point to it. Only the
 * owner can reset.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

const KEEP_WORKING = "Any guest or vendor links they copied keep working until you use Reset all guest and vendor links below.";

defineQualityTest(
  {
    id: "access-control.owner-can-reset-every-guest-and-vendor-link.old-links-stop-new-links-work",
    title: "the owner can reset every guest and vendor link at once (old links stop working, new ones work, nobody is emailed), and removing or lowering someone's access points to it",
    objective:
      "Confirms that the Remove question for a collaborator, and the note after lowering one's access, say copied guest and vendor links keep working until the reset; that an Edit collaborator gets 403 from the reset; that the owner's reset (after its confirmation, which says nothing is emailed) reports two guest links and one vendor link replaced -- a guest who never had a link is left alone -- after which the old RSVP links read NOT_FOUND and the old vendor link inactive, while the links the planner gets now work.",
    expectedOutcome:
      "Remove question and lowered-access note contain the 'keep working until you use Reset all guest and vendor links' sentence. Edit collaborator reset 403. Confirmation mentions nothing is emailed; result 'replaced 2 guest links and 1 vendor link'. Old RSVP links NOT_FOUND, old vendor link active false; new RSVP links OPEN, new vendor link active true.",
    requirementIds: ["REQ-ACCESS-CONTROL"],
    tags: ["@mutating", "@feature:collaboration", "@feature:rsvp", "@feature:budget", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page, browser }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const tokenOf = (url: string) => url.split("/").pop()!;
    const rsvpToken = async (guestId: string) => {
      const res = await context.request.post(api(`guests/${guestId}/rsvp-link`), { data: {} });
      expect(res.status()).toBe(200);
      return tokenOf(((await res.json()) as { rsvp: { url: string } }).rsvp.url);
    };
    const vendorToken = async (vendorId: string) => {
      const res = await context.request.post(api(`vendors/${vendorId}/share-link`), { data: {} });
      expect(res.status()).toBe(200);
      return tokenOf(((await res.json()) as { link: { url: string } }).link.url);
    };
    const rsvpStatus = async (token: string) =>
      ((await (await context.request.get(`/api/v1/rsvp/${token}`)).json()) as { rsvp: { status: string } }).rsvp.status;
    const vendorActive = async (token: string) =>
      ((await (await context.request.get(`/api/v1/vendor-view/${token}`)).json()) as { active: boolean }).active;

    const guestA = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const guestB = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex)); // never given a link
    const vendorRes = await context.request.post(api("vendors"), { data: { name: "Reset Test Florist", category: "FLORIST" } });
    expect(vendorRes.status()).toBe(201);
    const vendorId = ((await vendorRes.json()) as { vendor: { id: string } }).vendor.id;
    const oldA = await rsvpToken(guestA.id);
    const oldB = await rsvpToken(guestB.id);
    const oldVendor = await vendorToken(vendorId);

    const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "helper");
    try {
      await weddingData.addCollaborator(w, editor.email, "EDIT");
      await weddingData.addCollaborator(w, helper.email, "EDIT");
      const tab = new CollaboratorsTabPage(page);
      await tab.goto(w);

      await test.step("Removing or lowering someone's access points to the reset", async () => {
        const question = await tab.openRemoveQuestion(editor.email);
        await expect(question).toContainText(KEEP_WORKING);
        await tab.confirmDelete();
        await expect(tab.person(editor.email)).toHaveCount(0);
        // The helper is lowered to View instead.
        await tab.setAccessLevel(helper.name, "View");
        await expect(tab.loweredAccessNote()).toContainText(KEEP_WORKING);
      });

      await test.step("Only the owner can reset the links", async () => {
        const byHelper = await helper.context.request.post(api("reset-links"));
        expect(byHelper.status()).toBe(403);
        expect(await rsvpStatus(oldA)).toBe("OPEN");
      });

      await test.step("The owner's reset replaces every link that was handed out", async () => {
        const question = await tab.openResetLinks();
        await expect(question).toContainText("nothing is emailed automatically");
        await tab.confirmResetLinks();
        await expect(tab.resetLinksResult()).toContainText("replaced 2 guest links and 1 vendor link");
      });

      await test.step("Old links stop working; the new ones work", async () => {
        expect(await rsvpStatus(oldA)).toBe("NOT_FOUND");
        expect(await rsvpStatus(oldB)).toBe("NOT_FOUND");
        expect(await vendorActive(oldVendor)).toBe(false);
        const newA = await rsvpToken(guestA.id);
        expect(newA).not.toBe(oldA);
        expect(await rsvpStatus(newA)).toBe("OPEN");
        const newVendor = await vendorToken(vendorId);
        expect(newVendor).not.toBe(oldVendor);
        expect(await vendorActive(newVendor)).toBe(true);
      });
    } finally {
      await editor.context.close();
      await helper.context.close();
    }
  },
);
