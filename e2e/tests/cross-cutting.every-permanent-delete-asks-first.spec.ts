/**
 * TS-136 (REQ-NON-FUNCTIONAL) — every action that permanently deletes something asks "Are you
 * sure?" first, with a choice to go ahead or to cancel. Before TS-136, Remove on a guest, a
 * seating rule, an empty table, a timeline entry, a vendor or a collaborator, Revoke on an invite,
 * and Delete on a saved template all acted on the first click.
 *
 * For each of the eight: the question names what will be deleted, Cancel has the focus, Cancel
 * leaves the item in place (checked through the API, not just the screen), and "Yes, …" deletes
 * it. Escape is checked once, on the guest.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

defineQualityTest(
  {
    id: "cross-cutting.every-permanent-delete-asks-first.eight-deletes-cancel-escape-confirm",
    title: "removing a guest, rule, table, timeline entry, vendor or collaborator, revoking an invite, and deleting a template each ask first — Cancel keeps it, Yes deletes it",
    objective:
      "Confirms that each of the app's eight permanent-delete actions opens an 'Are you sure?' question naming the item, with focus on Cancel; that Cancel (and Escape) closes it with the item still saved; and that the 'Yes, …' button then deletes it.",
    expectedOutcome:
      "For the guest, rule, table, timeline entry, vendor, collaborator, invite and template: the question names the item, Cancel is focused, after Cancel the API still has the item, and after 'Yes, …' the API no longer has it. Escape on the guest's question closes it with the guest kept.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:non-functional", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context, browser }, testInfo) => {
    const w = managedWedding.id;
    const detail = new WeddingDetailPage(page);
    const ask = detail.deleteConfirmation();
    const full = (n: { firstName: string; lastName: string }) => `${n.firstName} ${n.lastName}`;
    const json = async (path: string) => (await context.request.get(path)).json();

    /** Opens the question, checks it, cancels (item kept), then confirms (item gone). */
    const cancelThenConfirm = async (trigger: string | RegExp, mentions: string, stillThere: () => Promise<boolean>) => {
      await detail.deleteTrigger(trigger).click();
      await expect(ask.question()).toContainText(mentions);
      await expect(ask.cancelButton()).toBeFocused();
      await ask.cancel();
      await expect(ask.question()).toHaveCount(0);
      expect(await stillThere()).toBe(true);

      await detail.deleteTrigger(trigger).click();
      await ask.confirm();
      await expect.poll(stillThere).toBe(false);
    };

    const a = uniquePersonName(testInfo.workerIndex);
    const b = uniquePersonName(testInfo.workerIndex);
    const guestA = await weddingData.createGuest(w, a);
    const guestB = await weddingData.createGuest(w, b);
    await weddingData.createRelationship(w, guestA.id, guestB.id, "MUST_SIT_TOGETHER");
    await weddingData.createTable(w, { label: "Spare Table", capacity: 4 });
    await weddingData.createTimelineEntry(w, { time: "18:00", description: "First dance" });
    const inviteEmail = `invitee.${Date.now()}@example.invalid`;
    expect((await weddingData.createInvite(w, inviteEmail, "VIEW")).status).toBe(201);
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "helper");
    await weddingData.addCollaborator(w, helper.email, "VIEW");
    await helper.context.close();
    const templateName = uniqueTitle(testInfo.workerIndex, "Confirm Template");
    await weddingData.saveWeddingAsTemplate(w, templateName);

    await page.goto(`/weddings/${w}`);

    await test.step("Seating rule", async () => {
      await detail.openTab("Seating rules");
      // The rule lists its two guests in whichever order the server keeps them.
      const either = new RegExp("^Remove the rule for (" + full(a) + " & " + full(b) + "|" + full(b) + " & " + full(a) + ")$");
      await cancelThenConfirm(either, full(a), async () => (await weddingData.listRelationships(w)).length === 1);
    });

    await test.step("Guest -- Escape cancels too", async () => {
      await detail.openTab("Guests");
      await detail.deleteTrigger(`Remove ${full(a)}`).click();
      await expect(ask.question()).toContainText("This can't be undone.");
      await page.keyboard.press("Escape");
      await expect(ask.question()).toHaveCount(0);
      const guestKept = async () => (await weddingData.listGuests(w)).some((g) => g.id === guestA.id);
      expect(await guestKept()).toBe(true);
      await cancelThenConfirm(`Remove ${full(a)}`, full(a), guestKept);
    });

    await test.step("Table with nobody seated", async () => {
      await detail.openTab("Tables");
      await cancelThenConfirm("Remove Spare Table", "Spare Table", async () =>
        (await weddingData.listTables(w)).some((t) => t.label === "Spare Table"),
      );
    });

    await test.step("Timeline entry", async () => {
      await detail.openTab("Timeline");
      await cancelThenConfirm("Remove First dance", "First dance", async () =>
        (await weddingData.getTimelineEntries(w)).some((e) => e.description === "First dance"),
      );
    });

    await test.step("Vendor", async () => {
      await detail.openTab("Budget");
      await new BudgetTabPage(page).addVendor({ name: "Confirm Florist" });
      await cancelThenConfirm("Remove Confirm Florist", "Confirm Florist", async () =>
        ((await json(`/api/v1/weddings/${w}/vendors`)) as { vendors: { name: string }[] }).vendors.some((v) => v.name === "Confirm Florist"),
      );
    });

    await test.step("Invite and collaborator", async () => {
      await detail.openTab("Collaborators");
      await cancelThenConfirm(`Revoke the invite for ${inviteEmail}`, inviteEmail, async () =>
        (await weddingData.listInvites(w)).some((i) => i.email === inviteEmail && i.status === "PENDING"),
      );
      const helperStillHasAccess = async () =>
        ((await json(`/api/v1/weddings/${w}/collaborators`)) as { collaborators: { userName: string }[] }).collaborators.some(
          (c) => c.userName === helper.name,
        );
      await cancelThenConfirm(`Remove ${helper.name}`, helper.name, helperStillHasAccess);
    });

    await test.step("Saved template, on the dashboard", async () => {
      await page.goto("/dashboard");
      const dashboard = new DashboardPage(page);
      await dashboard.openTemplatesList();
      await cancelThenConfirm(`Delete ${templateName}`, templateName, async () =>
        (await weddingData.listTemplates()).some((t) => t.name === templateName),
      );
    });
  },
);
