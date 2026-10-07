/**
 * TS-220 (review 8) -- what the planner is told matches what really happened:
 * - Revoking an invite the person accepted a moment ago is refused with a message saying so (it
 *   used to look like a successful revoke, while the person had access).
 * - Duplicating a wedding whose copy was saved but couldn't be read back opens the one copy -- the
 *   answer is never an error that would make the planner press again and make a second copy.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { inviteToken } from "../support/testDatabase.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";

const ACCEPTED_MESSAGE = "They accepted this invite a moment ago — remove them from Collaborators if needed.";
const SAVED_BUT_NOT_REFRESHED = "Saved, but Seatwise couldn't load the latest just now — refresh the page to see it.";

defineQualityTest(
  {
    id: "cross-cutting.revokes-and-copies-say-what-really-happened.revoke-after-accept-says-so",
    title: "revoking an invite the person accepted a moment ago says so, and they keep their access",
    objective:
      "Opens the owner's Collaborators tab with a pending invite, lets the invited (confirmed) account accept it through the API meanwhile, then presses Revoke and confirms. Confirms the revoke answers 409 with a message saying they accepted it, and that the person is still a collaborator -- before, the revoke answered 404, the page treated it as already revoked and the owner believed access was blocked.",
    expectedOutcome:
      "DELETE .../invites/<id> answers 409 and the page shows 'They accepted this invite a moment ago — remove them from Collaborators if needed.'. GET collaborators still lists the invited account once, and a further revoke through the API also answers 409 with the same message.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, browser }, testInfo) => {
    const w = managedWedding.id;
    const invitee = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "invitee");
    try {
      const sent = await weddingData.createInvite(w, invitee.email, "EDIT");
      expect(sent.status).toBe(201);
      const inviteId = sent.body.invite!.id;
      const token = await inviteToken(inviteId);
      const tab = new CollaboratorsTabPage(page);

      await test.step("The owner has the pending invite on screen when the person accepts it", async () => {
        await tab.goto(w);
        await expect(tab.pendingInvite(invitee.email)).toBeVisible();
        const accepted = await invitee.context.request.post(`/api/v1/invites/${token}/accept`, { data: {} });
        expect(accepted.status()).toBe(200);
      });

      await test.step("Revoking it now is refused with a message saying they accepted it", async () => {
        const [res] = await Promise.all([
          page.waitForResponse(
            (r) => r.request().method() === "DELETE" && new URL(r.url()).pathname.endsWith(`/invites/${inviteId}`),
          ),
          tab.revokeInvite(invitee.email),
        ]);
        expect(res.status()).toBe(409);
        expect(((await res.json()) as { error: string }).error).toBe(ACCEPTED_MESSAGE);
        await expect(tab.message(ACCEPTED_MESSAGE)).toBeVisible();
      });

      await test.step("The person still has access, and asking again gives the same answer", async () => {
        const collaborators = await weddingData.listCollaborators(w);
        expect(collaborators.filter((c) => c.userEmail === invitee.email)).toHaveLength(1);
        const again = await weddingData.revokeInvite(w, inviteId);
        expect(again.status).toBe(409);
        expect(again.body.error).toBe(ACCEPTED_MESSAGE);
      });
    } finally {
      await invitee.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.revokes-and-copies-say-what-really-happened.duplicate-with-lost-read-back-makes-one-copy",
    title: "a duplicated wedding that saved but couldn't be read back opens the one copy, with no error",
    objective:
      "Presses 'Duplicate layout' on the dashboard and lets the request reach the server (so the copy is saved), then hands the page the answer the server gives when reading the new wedding back fails -- just the new wedding's id and the 'Saved, but…' warning. Confirms the page opens the copy and no error is shown, and that exactly one copy exists -- before, the failed read-back answered 500 and a planner pressing again made a second copy.",
    expectedOutcome:
      "The page goes to /weddings/<copy id>. GET /api/v1/weddings lists exactly one wedding named '<name> - copy', with that id.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context }) => {
    const source = managedWedding;
    const dashboard = new DashboardPage(page);
    let copyId = "";

    await test.step("The copy is saved, but its read-back is lost", async () => {
      await page.route(`**/api/v1/weddings/${source.id}/duplicate`, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        const response = await route.fetch();
        const body = (await response.json()) as { wedding?: { id: string } };
        if (body.wedding?.id) weddingData.trackWedding(body.wedding.id);
        return route.fulfill({
          response,
          contentType: "application/json",
          body: JSON.stringify(
            body.wedding?.id ? { wedding: { id: body.wedding.id }, warnings: [SAVED_BUT_NOT_REFRESHED] } : body,
          ),
        });
      });
      await dashboard.goto();
      await Promise.all([
        page.waitForURL((url) => /^\/weddings\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(source.id)),
        dashboard.duplicateLayoutButton(source.name).click(),
      ]);
      copyId = new URL(page.url()).pathname.split("/").pop()!;
    });

    await test.step("Exactly one copy exists, and it's the one that opened", async () => {
      const res = await context.request.get("/api/v1/weddings");
      expect(res.status()).toBe(200);
      const weddings = ((await res.json()) as { weddings: { id: string; name: string }[] }).weddings;
      const copies = weddings.filter((x) => x.name === `${source.name} - copy`);
      expect(copies.map((x) => x.id)).toEqual([copyId]);
    });
  },
);
