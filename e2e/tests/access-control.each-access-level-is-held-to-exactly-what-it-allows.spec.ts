/**
 * TS-116 (REQ-COLLABORATION-NOTIFICATIONS, REQ-NON-FUNCTIONAL) — every access level held to exactly
 * what it allows, by the server and on screen.
 *
 * The existing access-control spec covers a stranger with *no* access. This covers the people who
 * do have access, at each level below the one an action needs (levels read from each route's own
 * `requireAccess` call):
 *
 * - An **Edit** collaborator can change the plan but never the wedding itself: renaming or
 *   deleting it, inviting or managing people, email-notification settings, and duplicating the
 *   layout are all owner-only (403), and none of those controls are shown to them.
 * - **View** and **Comment** collaborators can't change guests, tables, rules, day-of attendance,
 *   imports, the plan, or templates (403), and each of those tabs tells them so with its
 *   read-only notice instead of edit controls. Budget, timeline, plan moves, restore and comments
 *   already have their own permission specs.
 *
 * After every refusal, the wedding is checked to be exactly as it was.
 */

import type { APIRequestContext } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniquePersonName } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

type Method = "get" | "post" | "patch" | "put" | "delete";
interface Attempt {
  label: string;
  method: Method;
  path: string;
  data?: unknown;
}

async function expectAllRefused(request: APIRequestContext, attempts: Attempt[]): Promise<void> {
  for (const a of attempts) {
    const res = await request[a.method](a.path, a.data === undefined ? undefined : { data: a.data });
    expect(res.status(), `${a.label} (${a.method.toUpperCase()} ${a.path})`).toBe(403);
  }
}

defineQualityTest(
  {
    id: "access-control.each-access-level-is-held-to-exactly-what-it-allows.edit-owner-only-and-view-comment-read-only",
    title: "an Edit collaborator is refused every owner-only action and never shown those controls, and View and Comment collaborators are refused every write and shown read-only notices",
    objective:
      "Confirms that owner-only actions (rename, delete, invites, collaborators, notification settings, duplicate) are refused for an Edit collaborator with 403 and not rendered for them, and that guest, table, rule, day-of, import, generate, plan and template writes are refused for View and Comment collaborators with 403, with each tab showing its read-only notice -- and that nothing about the wedding changed.",
    expectedOutcome:
      "Every listed attempt returns 403. The Edit collaborator's Collaborators tab has no invite form and no Remove buttons, and their dashboard has no Duplicate layout button for the shared wedding. The View collaborator sees the view-only notice on the Guests, Seating rules, Tables, Seating plan and Day-of mode tabs. Afterwards the wedding's name, guests, tables, rules, plan versions, invites and collaborators are unchanged.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, browser }, testInfo) => {
    const w = `/api/v1/weddings/${managedWedding.id}`;
    const a = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
    const b = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
    const table = await weddingData.createTable(managedWedding.id, { label: "Table 1", capacity: 8 });
    const rule = await weddingData.createRelationship(managedWedding.id, a.id, b.id, "PREFER_NEAR");
    const plan = await weddingData.generatePlanVersion(managedWedding.id);
    const pending = await weddingData.createInvite(managedWedding.id, `pw-pending-${a.id.slice(0, 8)}@example.invalid`, "VIEW");
    expect(pending.status).toBe(201);

    const edit = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "edit");
    const comment = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "comment");
    const view = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "view");

    const snapshot = async () => ({
      wedding: (await weddingData.getWedding(managedWedding.id)).name,
      guests: (await weddingData.listGuests(managedWedding.id)).map((g) => `${g.id}:${g.firstName}`).sort(),
      tables: (await weddingData.listTables(managedWedding.id)).map((t) => `${t.id}:${t.label}:${t.capacity}`).sort(),
      rules: (await weddingData.listRelationships(managedWedding.id)).map((r) => r.id).sort(),
      plans: (await weddingData.listPlanVersions(managedWedding.id)).map((p) => `${p.id}:${p.status}`).sort(),
      invites: (await weddingData.listInvites(managedWedding.id)).map((i) => `${i.id}:${i.status}`).sort(),
      collaborators: (await weddingData.listCollaborators(managedWedding.id)).map((c) => `${c.userEmail}:${c.permissionLevel}:${c.role}`).sort(),
    });

    try {
      await weddingData.addCollaborator(managedWedding.id, edit.email, "EDIT");
      await weddingData.addCollaborator(managedWedding.id, comment.email, "COMMENT");
      await weddingData.addCollaborator(managedWedding.id, view.email, "VIEW");
      const viewCollaboratorId = (await weddingData.listCollaborators(managedWedding.id)).find((c) => c.userEmail === view.email)!.id;
      const before = await snapshot();

      await test.step("Edit collaborator: every owner-only action is refused", async () => {
        await expectAllRefused(edit.context.request, [
          { label: "rename the wedding", method: "patch", path: w, data: { name: "Renamed" } },
          { label: "delete the wedding", method: "delete", path: w },
          { label: "list invites", method: "get", path: `${w}/invites` },
          { label: "send an invite", method: "post", path: `${w}/invites`, data: { email: "pw-x@example.invalid", permissionLevel: "EDIT" } },
          { label: "revoke an invite", method: "delete", path: `${w}/invites/${pending.body.invite!.id}` },
          { label: "add a collaborator directly", method: "post", path: `${w}/collaborators`, data: { email: comment.email, permissionLevel: "EDIT" } },
          { label: "change someone's level", method: "patch", path: `${w}/collaborators/${viewCollaboratorId}`, data: { permissionLevel: "EDIT" } },
          { label: "remove someone", method: "delete", path: `${w}/collaborators/${viewCollaboratorId}` },
          { label: "email-notification setting", method: "patch", path: `${w}/notification-settings`, data: { emailNotificationsEnabled: false } },
          { label: "duplicate the layout", method: "post", path: `${w}/duplicate`, data: {} },
        ]);
      });

      await test.step("Edit collaborator: owner-only controls aren't shown", async () => {
        const editPage = await edit.context.newPage();
        const tab = new CollaboratorsTabPage(editPage);
        await tab.goto(managedWedding.id);
        await expect(tab.person(view.email)).toBeVisible();
        await expect(tab.inviteFormHeading()).toHaveCount(0);
        await expect(tab.removeButtons()).toHaveCount(0);

        const dashboard = new DashboardPage(editPage);
        await dashboard.goto();
        await expect(dashboard.textLocator(managedWedding.name)).toBeVisible();
        await expect(dashboard.duplicateLayoutButton(managedWedding.name)).toHaveCount(0);
      });

      const readOnlyWrites: Attempt[] = [
        { label: "add a guest", method: "post", path: `${w}/guests`, data: { firstName: "No", lastName: "Access" } },
        { label: "edit a guest", method: "patch", path: `${w}/guests/${a.id}`, data: { firstName: "Changed" } },
        { label: "remove a guest", method: "delete", path: `${w}/guests/${a.id}` },
        { label: "mark attendance", method: "post", path: `${w}/guests/${a.id}/attendance`, data: { attending: false } },
        { label: "make an RSVP link", method: "post", path: `${w}/guests/${a.id}/rsvp-link`, data: {} },
        { label: "preview an import", method: "post", path: `${w}/guests/import/preview`, data: { csv: "firstName,lastName\nNo,Access\n" } },
        { label: "commit an import", method: "post", path: `${w}/guests/import/commit`, data: { csv: "firstName,lastName\nNo,Access\n", mapping: { firstName: "firstName", lastName: "lastName" } } },
        { label: "add a table", method: "post", path: `${w}/tables`, data: { label: "Nope", capacity: 4 } },
        { label: "quick-create tables", method: "post", path: `${w}/tables/quick-create`, data: { count: 2, capacity: 8 } },
        { label: "edit a table", method: "patch", path: `${w}/tables/${table.id}`, data: { capacity: 2 } },
        { label: "remove a table", method: "delete", path: `${w}/tables/${table.id}` },
        { label: "set required guests", method: "put", path: `${w}/tables/${table.id}/required-guests`, data: { guestIds: [a.id] } },
        { label: "add a rule", method: "post", path: `${w}/relationships`, data: { guestAId: a.id, guestBId: b.id, type: "AVOID" } },
        { label: "remove a rule", method: "delete", path: `${w}/relationships/${rule.id}` },
        { label: "generate a plan", method: "post", path: `${w}/plan-versions/generate`, data: {} },
        { label: "rename a plan version", method: "patch", path: `${w}/plan-versions/${plan.id}`, data: { nickname: "Nope" } },
        { label: "swap two guests", method: "post", path: `${w}/plan-versions/${plan.id}/assignments/swap`, data: { guestAId: a.id, guestBId: b.id } },
        { label: "save as a template", method: "post", path: `${w}/save-as-template`, data: { name: "Nope" } },
        { label: "apply a template", method: "post", path: `${w}/apply-template`, data: { templateId: a.id, applyTables: true, applyRules: false } },
      ];

      await test.step("Comment collaborator: every guest, table, rule, day-of, import, plan and template write is refused", async () => {
        await expectAllRefused(comment.context.request, readOnlyWrites);
      });

      await test.step("View collaborator: the same writes are refused", async () => {
        await expectAllRefused(view.context.request, readOnlyWrites);
      });

      await test.step("View collaborator: each tab says it's read-only instead of offering edits", async () => {
        const viewPage = new WeddingDetailPage(await view.context.newPage());
        await viewPage.goto(managedWedding.id);
        for (const [tab, notice] of [
          ["Guests", "You have view-only access to this wedding's guest list"],
          ["Seating rules", "You have view-only access to this wedding's seating rules"],
          ["Tables", "You have view-only access to this wedding's tables"],
          ["Seating plan", "You have view-only access to this wedding's seating plan"],
          ["Day-of mode", "You have view-only access to this wedding"],
        ] as const) {
          await viewPage.openTab(tab);
          await expect(viewPage.textLocator(notice).first(), `${tab} tab`).toBeVisible();
        }
      });

      await test.step("Nothing about the wedding changed", async () => {
        expect(await snapshot()).toEqual(before);
      });
    } finally {
      await Promise.all([edit.context.close(), comment.context.close(), view.context.close()]);
    }
  },
);
