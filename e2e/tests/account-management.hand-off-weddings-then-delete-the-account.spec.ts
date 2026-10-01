/**
 * TS-105 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — a planner can hand a wedding to one of its
 * collaborators, and can delete their own account only once every wedding they own has been
 * handed off (Tom's decision, 2026-10-01: no wedding is ever left with nobody in charge).
 *
 * Deleting needs the account's password. Comments the deleted account wrote stay, shown as
 * written by "Former member"; the wedding, now owned by the collaborator, carries on untouched.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import type { APIRequestContext, Browser } from "@playwright/test";
import { uniquePersonName, uniqueTitle, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { AccountPage } from "../pages/AccountPage.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";

async function signUp(browser: Browser, workerIndex: number, label: string) {
  const context = await browser.newContext();
  const token = uniqueToken(workerIndex);
  const name = `Playwright Tester ${label} ${token}`;
  const email = `pw-tester-${label}-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
  const password = `pw-${token}-long-enough`;
  const res = await context.request.post("/api/v1/auth/signup", { data: { name, email, password } });
  expect(res.ok()).toBe(true);
  return { context, name, email, password, request: context.request as APIRequestContext };
}

defineQualityTest(
  {
    id: "account-management.hand-off-weddings-then-delete-the-account.wrong-password-blocked-handoff-delete",
    title: "an owner can't delete their account while they own a wedding, can hand it to a collaborator, and can then delete it -- with the wrong password refused and their comments kept",
    objective:
      "Confirms that deleting an account with the wrong password is refused; that with the right password it's refused while the account owns a wedding, listing that wedding; that Hand off on the Collaborators tab makes the chosen collaborator the owner and leaves the old owner with Edit access and no Hand off section; that the account can then be deleted and can no longer sign in; and that the wedding carries on under its new owner with the deleted account's comment kept as 'Former member'.",
    expectedOutcome:
      "Wrong password: 'That password isn't right.'. Right password while owning: 'Hand off every wedding you own…' with the wedding listed. After hand-off: the old owner's badge reads 'Your access: Edit', the Hand off section is gone, and the new owner's API view shows accessLevel OWNER. After deleting: the 'deleted' heading shows and signing in fails. The new owner still sees the wedding, no longer lists the old owner, and the comment shows 'Former member'.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:high", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const owner = await signUp(browser, testInfo.workerIndex, "owner");
    const helper = await signUp(browser, testInfo.workerIndex, "helper");
    try {
      const weddingName = uniqueTitle(testInfo.workerIndex, "Handoff Wedding");
      const w = ((await (await owner.request.post("/api/v1/weddings", { data: { name: weddingName } })).json()) as {
        wedding: { id: string };
      }).wedding.id;
      expect(
        (await owner.request.post(`/api/v1/weddings/${w}/collaborators`, {
          data: { email: helper.email, permissionLevel: "EDIT", role: "COLLABORATOR" },
        })).ok(),
      ).toBe(true);
      const guest = ((await (await owner.request.post(`/api/v1/weddings/${w}/guests`, { data: uniquePersonName(testInfo.workerIndex) })).json()) as {
        guest: { id: string };
      }).guest;
      expect(
        (await owner.request.post(`/api/v1/weddings/${w}/comments`, {
          data: { targetType: "GUEST", guestId: guest.id, body: "Owner's note before leaving" },
        })).ok(),
      ).toBe(true);

      const page = await owner.context.newPage();
      const account = new AccountPage(page);

      await test.step("Deleting with the wrong password is refused", async () => {
        await account.goto();
        await account.deleteAccount("not-my-password");
        await expect(account.message("That password isn't right.")).toBeVisible();
      });

      await test.step("Deleting while still owning a wedding is refused, and the wedding is listed", async () => {
        await account.deleteAccount(owner.password);
        await expect(account.message(/^Hand off every wedding you own before deleting your account\.$/)).toBeVisible();
        await expect(account.ownedWeddingLink(weddingName)).toBeVisible();
      });

      await test.step("Hand off makes the collaborator the owner; the old owner keeps Edit access", async () => {
        const collaborators = new CollaboratorsTabPage(page);
        await collaborators.goto(w);
        await collaborators.handOffTo(helper.name);
        const detail = new WeddingDetailPage(page);
        await expect(detail.yourAccessBadge()).toHaveText("Your access: Edit");
        await collaborators.goto(w);
        await expect(collaborators.handOffSection()).toHaveCount(0);
        const asHelper = (await (await helper.request.get(`/api/v1/weddings/${w}`)).json()) as { accessLevel?: string };
        expect(asHelper.accessLevel).toBe("OWNER");
      });

      await test.step("Now the account can be deleted, and can't sign in again", async () => {
        await account.goto();
        await account.deleteAccount(owner.password);
        await expect(account.deletedHeading()).toBeVisible();
        const login = await helper.request.post("/api/v1/auth/login", { data: { email: owner.email, password: owner.password } });
        expect(login.ok()).toBe(false);
      });

      await test.step("The wedding carries on under its new owner, and the old owner's comment is kept", async () => {
        expect((await helper.request.get(`/api/v1/weddings/${w}`)).ok()).toBe(true);
        const people = ((await (await helper.request.get(`/api/v1/weddings/${w}/collaborators`)).json()) as {
          collaborators: { userName: string }[];
        }).collaborators;
        expect(people.map((p) => p.userName)).not.toContain(owner.name);
        const comments = ((await (await helper.request.get(`/api/v1/weddings/${w}/comments`)).json()) as {
          comments: { body: string; authorName: string }[];
        }).comments;
        expect(comments.find((c) => c.body === "Owner's note before leaving")?.authorName).toBe("Former member");
      });
    } finally {
      await owner.context.close();
      await helper.context.close();
    }
  },
);
