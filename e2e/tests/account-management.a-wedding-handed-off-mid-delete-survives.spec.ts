/**
 * TS-187 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — a wedding handed to someone at the very moment they
 * delete their account is never deleted along with it (reproduced before the fix: the delete's
 * "owns nothing" check couldn't see the hand-off, which wasn't saved yet, so the delete went ahead
 * once it was -- and took the wedding with it).
 *
 * The race is made exact from the test: the hand-off is paused half-way -- the collaborator is
 * already the owner, nothing is saved yet (holdOwnershipHandOff) -- while the new owner deletes
 * their account. Then the hand-off is let go. Separately, the database itself is checked to refuse
 * deleting an account that owns a wedding (ON DELETE RESTRICT), so nothing that skips the app's own
 * check can delete a wedding with its owner either.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import type { APIRequestContext, Browser } from "@playwright/test";
import { uniqueTestAddress, uniqueTitle, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { confirmTestAccountEmail, databaseErrorDeletingAccount, holdOwnershipHandOff } from "../support/testDatabase.js";

async function signUp(browser: Browser, workerIndex: number, label: string) {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
  const token = uniqueToken(workerIndex);
  const name = `Playwright Tester ${label} ${token}`;
  const email = `pw-tester-${label}-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
  const password = `pw-${token}-long-enough`;
  const res = await context.request.post("/api/v1/auth/signup", { data: { name, email, password } });
  expect(res.ok()).toBe(true);
  await confirmTestAccountEmail(email);
  return { context, name, email, password, request: context.request as APIRequestContext };
}

defineQualityTest(
  {
    id: "account-management.a-wedding-handed-off-mid-delete-survives.handoff-races-account-delete",
    title: "a wedding handed to someone while they delete their account survives -- the delete is refused, listing it -- and the database itself refuses to delete an account that owns a wedding",
    objective:
      "Confirms that when an owner's hand-off of a wedding to a collaborator is paused half-way (the collaborator already the owner, nothing saved yet) and the collaborator deletes their account in that moment, the delete waits for the hand-off, then is refused because the account now owns the wedding; the hand-off succeeds; the wedding is still there with the collaborator as its owner and their account still works. Also confirms that deleting that account straight in the database (skipping the app's check) is refused by the database itself.",
    expectedOutcome:
      "Hand-off: 200. Account delete: 409 'Hand off every wedding you own…' with the handed-off wedding in ownedWeddings. The new owner's GET of the wedding is 200 with accessLevel OWNER, and they can still sign in. A direct database delete of the new owner's account fails with 23503 (nothing is deleted).",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@feature:collaboration", "@risk:critical", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const owner = await signUp(browser, testInfo.workerIndex, "owner");
    const helper = await signUp(browser, testInfo.workerIndex, "helper");
    let weddingId = "";
    try {
      const weddingName = uniqueTitle(testInfo.workerIndex, "Handoff Race Wedding");
      weddingId = ((await (await owner.request.post("/api/v1/weddings", { data: { name: weddingName } })).json()) as {
        wedding: { id: string };
      }).wedding.id;
      const added = await owner.request.post(`/api/v1/weddings/${weddingId}/collaborators`, {
        data: { email: helper.email, permissionLevel: "EDIT", role: "COLLABORATOR" },
      });
      expect(added.ok()).toBe(true);
      const collaboratorId = ((await added.json()) as { collaborator: { id: string } }).collaborator.id;

      await test.step("The collaborator deletes their account while a hand-off to them is half-way through", async () => {
        const held = await holdOwnershipHandOff(weddingId, owner.email);
        let handingOff;
        let deleting;
        try {
          handingOff = owner.request.post(`/api/v1/weddings/${weddingId}/transfer-ownership`, { data: { collaboratorId } });
          await held.waitForWaiters(1);
          deleting = helper.request.delete("/api/v1/auth/me", { data: { password: helper.password } });
          // The delete is now waiting on the paused hand-off.
          await held.waitForWaiters(2);
        } finally {
          await held.release();
        }
        const [handedOff, deleted] = await Promise.all([handingOff, deleting]);
        expect(handedOff.status()).toBe(200);
        expect(deleted!.status()).toBe(409);
        const body = (await deleted!.json()) as { error: string; ownedWeddings: { id: string; name: string }[] };
        expect(body.error).toBe("Hand off every wedding you own before deleting your account.");
        expect(body.ownedWeddings.map((w) => w.id)).toContain(weddingId);
      });

      await test.step("The wedding is still there, owned by the collaborator, whose account still works", async () => {
        const res = await helper.request.get(`/api/v1/weddings/${weddingId}`);
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { accessLevel?: string }).accessLevel).toBe("OWNER");
        const login = await helper.request.post("/api/v1/auth/login", { data: { email: helper.email, password: helper.password } });
        expect(login.ok()).toBe(true);
      });

      await test.step("The database itself refuses to delete an account that owns a wedding", async () => {
        expect(await databaseErrorDeletingAccount(helper.email)).toBe("23503");
        expect((await helper.request.get(`/api/v1/weddings/${weddingId}`)).status()).toBe(200);
      });
    } finally {
      // The wedding now belongs to the helper; remove it with their account (the run's sweep would too).
      if (weddingId) await helper.request.delete(`/api/v1/weddings/${weddingId}`).catch(() => {});
      await owner.context.close();
      await helper.context.close();
    }
  },
);
