/**
 * TS-204 (REQ-COLLABORATION-NOTIFICATIONS, Tom's decision) — the wedding's note is the owner's
 * alone. No screen showed it to collaborators, but it was sent to their browser with the wedding
 * and the dashboard list; it's now left out of both for anyone but the owner.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { uniqueToken } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { patchWedding } from "../data/api.js";

defineQualityTest(
  {
    id: "cross-cutting.wedding-note-stays-with-the-owner.view-collaborator-never-receives-it",
    title: "a View collaborator never receives the wedding's note, on the wedding or the dashboard",
    objective:
      "Confirms (TS-204) that after the owner saves a note on the wedding, a View collaborator's answers for the wedding and for their dashboard list carry no note at all, their dashboard and the wedding's Collaborators tab never show the note's text, and the owner still gets the note.",
    expectedOutcome:
      "The collaborator's GET /weddings/:id and GET /weddings answers have no 'note' key and don't contain the note's text, including the answers their browser loads while showing the dashboard and the wedding; the note's text appears nowhere on either page. The owner's GET /weddings/:id has the note.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    const w = managedWedding.id;
    const note = `Owner-only note ${uniqueToken(testInfo.workerIndex)}: budget is tight, keep it quiet`;
    const saved = await patchWedding(context.request, w, { data: { note } });
    expect(saved.ok(), await saved.text()).toBe(true);
    const viewer = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "viewer");

    try {
      await weddingData.addCollaborator(w, viewer.email, "VIEW");

      await test.step("The collaborator's answers carry no note", async () => {
        const one = await viewer.context.request.get(`/api/v1/weddings/${w}`);
        expect(one.status()).toBe(200);
        const oneBody = (await one.json()) as { wedding: Record<string, unknown> };
        expect(oneBody.wedding).not.toHaveProperty("note");
        expect(JSON.stringify(oneBody)).not.toContain(note);

        const list = await viewer.context.request.get("/api/v1/weddings");
        const listBody = (await list.json()) as { weddings: Record<string, unknown>[] };
        const listed = listBody.weddings.find((x) => x.id === w);
        expect(listed).toBeDefined();
        expect(listed).not.toHaveProperty("note");
        expect(JSON.stringify(listBody)).not.toContain(note);
      });

      await test.step("Neither the dashboard nor the wedding shows it, and the browser never receives it", async () => {
        const page = await viewer.context.newPage();
        const answerFor = (path: string) =>
          page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === path);

        const dashboard = new DashboardPage(page);
        const [listAnswer] = await Promise.all([answerFor("/api/v1/weddings"), dashboard.goto()]);
        await expect(dashboard.weddingLink(managedWedding.name)).toBeVisible();
        await expect(dashboard.textLocator(note)).toHaveCount(0);
        expect(await listAnswer.text()).not.toContain(note);

        const collaborators = new CollaboratorsTabPage(page);
        const [weddingAnswer] = await Promise.all([answerFor(`/api/v1/weddings/${w}`), collaborators.goto(w)]);
        await expect(collaborators.textLocator(note)).toHaveCount(0);
        expect(await weddingAnswer.text()).not.toContain(note);
      });

      await test.step("The owner still has the note", async () => {
        const res = await context.request.get(`/api/v1/weddings/${w}`);
        expect(((await res.json()) as { wedding: { note: string } }).wedding.note).toBe(note);
      });
    } finally {
      await viewer.context.close();
    }
  },
);
