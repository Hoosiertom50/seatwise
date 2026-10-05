/**
 * TS-172 (REQ-ACCESS-CONTROL) — hardening from the third deep dive, and Tom's two decisions
 * (2026-10-05):
 * - Only the people who can approve a plan (owner, or a Couple member with Comment/Edit) can undo
 *   an approval; an ordinary Edit collaborator can't.
 * - View and Comment collaborators don't see guests' email addresses or vendors' contract notes
 *   (costs and contacts stay visible); Edit and the owner see everything.
 * - A write with a body but no Content-Type is refused (415).
 * - Sign-in responses carry the session token only for the mobile app (which asks for it).
 * - Private link pages are marked noindex.
 * - A template's source wedding is shown only while its owner still has access to that wedding.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueToken } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

defineQualityTest(
  {
    id: "cross-cutting.hardening-and-privacy-decisions-hold.unapprove-visibility-json-token-noindex-templates",
    title: "only approvers can undo an approval, View/Comment don't see guest emails or contract notes, body writes must be JSON, the web gets no token in sign-in bodies, private links are noindex, and old templates forget weddings they lost access to",
    objective:
      "Confirms that an Edit collaborator who isn't a Couple member gets 403 moving an Approved plan back to Draft while a Couple member succeeds; that View and Comment collaborators get guests with email null and vendors with contractNotes null (costs kept) while Edit sees both; that a POST with a body and no Content-Type gets 415; that a login response has no token unless sent with x-seatwise-client: mobile; that /rsvp/<token> answers with X-Robots-Tag noindex; and that a removed collaborator's saved template no longer shows the wedding it came from.",
    expectedOutcome:
      "Edit un-approve 403, Couple un-approve 200. View/Comment: email null, contractNotes null, costCents present; Edit: both present. No-Content-Type POST 415. Login body has no token, mobile login body has a token. X-Robots-Tag contains noindex. Removed collaborator's template has sourceWeddingName null.",
    requirementIds: ["REQ-ACCESS-CONTROL"],
    tags: ["@mutating", "@feature:collaboration", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser, playwright }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const baseURL = testInfo.project.use.baseURL!;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    const guest = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), email: `pw-guest-${Date.now()}@example.invalid` });
    const vendor = await context.request.post(api("vendors"), {
      data: { name: "Private Notes Florist", category: "FLORIST", costCents: 120000, contractNotes: "Deposit paid by card" },
    });
    expect(vendor.status()).toBe(201);

    const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
    const couple = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "couple");
    const viewer = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "viewer");
    const commenter = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "commenter");
    try {
      const editorRow = await weddingData.addCollaborator(w, editor.email, "EDIT");
      await weddingData.addCollaborator(w, couple.email, "EDIT", "COUPLE");
      await weddingData.addCollaborator(w, viewer.email, "VIEW");
      await weddingData.addCollaborator(w, commenter.email, "COMMENT");

      await test.step("Only the owner or a Couple member can undo an approval", async () => {
        const plan = await weddingData.generatePlanVersion(w);
        expect((await weddingData.setPlanVersionStatus(w, plan.id, "IN_REVIEW")).status).toBe(200);
        expect((await weddingData.setPlanVersionStatus(w, plan.id, "APPROVED")).status).toBe(200);
        const byEditor = await editor.context.request.post(api(`plan-versions/${plan.id}/status`), { data: { status: "DRAFT" } });
        expect(byEditor.status()).toBe(403);
        expect(((await byEditor.json()) as { error: string }).error).toContain("undo an approval");
        const byCouple = await couple.context.request.post(api(`plan-versions/${plan.id}/status`), { data: { status: "IN_REVIEW" } });
        expect(byCouple.status()).toBe(200);
        // Draft <-> In review is still open to Edit.
        expect((await editor.context.request.post(api(`plan-versions/${plan.id}/status`), { data: { status: "DRAFT" } })).status()).toBe(200);
      });

      await test.step("View and Comment don't see guest emails or contract notes; Edit does", async () => {
        const seenBy = async (request: typeof context.request) => {
          const g = ((await (await request.get(api(`guests/${guest.id}`))).json()) as { guest: { email: string | null } }).guest;
          const vs = ((await (await request.get(api("vendors"))).json()) as { vendors: { name: string; contractNotes: string | null; costCents: number | null }[] }).vendors;
          const v = vs.find((x) => x.name === "Private Notes Florist")!;
          return { email: g.email, contractNotes: v.contractNotes, costCents: v.costCents };
        };
        for (const who of [viewer, commenter]) {
          expect(await seenBy(who.context.request)).toEqual({ email: null, contractNotes: null, costCents: 120000 });
        }
        const forEditor = await seenBy(editor.context.request);
        expect(forEditor.email).toContain("@example.invalid");
        expect(forEditor.contractNotes).toBe("Deposit paid by card");
      });

      await test.step("A removed collaborator's template no longer shows the wedding it came from", async () => {
        const saved = await editor.context.request.post(api("save-as-template"), { data: { name: `Editor layout ${uniqueToken(testInfo.workerIndex)}` } });
        expect(saved.status()).toBe(201);
        const templateId = ((await saved.json()) as { template: { id: string } }).template.id;
        const shownTo = async () =>
          ((await (await editor.context.request.get(`/api/v1/templates/${templateId}`)).json()) as { template: { sourceWeddingName: string | null } })
            .template.sourceWeddingName;
        expect(await shownTo()).toBe(managedWedding.name);
        expect((await context.request.delete(api(`collaborators/${editorRow.id}`))).ok()).toBe(true);
        expect(await shownTo()).toBeNull();
      });
    } finally {
      for (const s of [editor, couple, viewer, commenter]) await s.context.close();
    }

    await test.step("A write with a body but no Content-Type is refused", async () => {
      const res = await fetch(new URL(api("guests"), baseURL), {
        method: "POST",
        body: new Blob([JSON.stringify(uniquePersonName(testInfo.workerIndex))]),
      });
      expect(res.status).toBe(415);
    });

    await test.step("Sign-in bodies carry the session token only for the mobile app", async () => {
      const email = `pw-tester-token-${uniqueToken(testInfo.workerIndex)}@example.invalid`;
      const password = randomBytes(12).toString("hex");
      const client = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
      try {
        const signup = await client.post("/api/v1/auth/signup", { data: { name: "Playwright Tester Token", email, password } });
        expect(signup.status()).toBe(201);
        expect(((await signup.json()) as { token?: string }).token).toBeUndefined();
        const web = await client.post("/api/v1/auth/login", { data: { email, password } });
        expect(((await web.json()) as { token?: string }).token).toBeUndefined();
        const mobile = await client.post("/api/v1/auth/login", { data: { email, password }, headers: { "x-seatwise-client": "mobile" } });
        expect(((await mobile.json()) as { token?: string }).token).toBeTruthy();
      } finally {
        await client.dispose();
      }
    });

    await test.step("Private link pages are marked noindex", async () => {
      const res = await context.request.get(`/rsvp/${"0".repeat(64)}`);
      expect(res.headers()["x-robots-tag"]).toContain("noindex");
    });
  },
);
