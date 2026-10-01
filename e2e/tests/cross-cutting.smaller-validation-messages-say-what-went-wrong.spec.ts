/**
 * TS-118 (REQ-NON-FUNCTIONAL) — the smaller validation messages and guards the 2026-09-30 coverage
 * audit found untested through the UI. Each is checked for the exact message a planner sees, and
 * that nothing was saved:
 *
 * - Seating rules: no guests picked (the browser blocks it), the same guest twice, and a duplicate.
 * - Guest CSV import: "See an example", "Download example CSV", a file with no header row, a file
 *   whose columns can't fill First/Last name (Preview stays disabled), and Cancel.
 * - Sign-up: a short password (the browser blocks it) and an email that's already registered.
 * - New wedding from a template: unticking both parts shows "Pick at least one" and disables Add.
 * - New wedding with a note: the note is saved.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle, uniqueToken } from "../data/ids.js";
import { RulesTabPage } from "../pages/RulesTabPage.js";
import { SignupPage } from "../pages/SignupPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";

defineQualityTest(
  {
    id: "cross-cutting.smaller-validation-messages-say-what-went-wrong.rules-import-signup-template-note",
    title: "rules, CSV import, sign-up and new-wedding forms each refuse bad input with a message that says what's wrong, and save a note when given one",
    objective:
      "Confirms the Seating rules form saves nothing with no guests picked, says 'Pick two different guests.' for the same guest twice, and refuses a duplicate rule; that the CSV import shows and hides its example, downloads the example file, says 'Couldn't find a header row in that file.' for an empty file, keeps Preview disabled when First/Last name can't be mapped, and Cancel clears the form; that sign-up blocks a short password before sending it and refuses an already-registered email with its message; that a template with neither part ticked shows the 'Pick at least one' warning with Add wedding disabled; and that a new wedding's note is saved.",
    expectedOutcome:
      "Rules: nothing is saved with no picks, the message shows for the same guest twice, the duplicate shows 'That rule already exists for these two guests.', and only one rule exists. Import: the example table toggles, the download is seatwise-guest-import-example.csv starting with a First name header, the empty file shows the header-row message, Preview is disabled for unmappable columns, and Cancel removes the mapping form. Sign-up: the password field reports a validation message and no account exists for it, and 'An account with that email already exists' shows. Template: the warning shows and Add wedding is disabled until one part is ticked again. The new wedding's note matches.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:non-functional", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, page, context, browser }, testInfo) => {
    const w = managedWedding.id;
    const a = uniquePersonName(testInfo.workerIndex);
    const b = uniquePersonName(testInfo.workerIndex);
    const full = (n: { firstName: string; lastName: string }) => `${n.firstName} ${n.lastName}`;
    await weddingData.createGuest(w, a);
    await weddingData.createGuest(w, b);

    await test.step("Seating rules: no guests, the same guest twice, and a duplicate are refused", async () => {
      const rules = new RulesTabPage(page);
      await rules.goto(w);
      await rules.openRulesTab();
      // With nothing picked the browser itself stops the submit (both pickers are required).
      await rules.submitRuleWith(null, null);
      expect(await weddingData.listRelationships(w)).toHaveLength(0);
      await rules.submitRuleWith(full(a), full(a));
      await expect(rules.message("Pick two different guests.")).toBeVisible();

      await rules.addRule(full(a), full(b), "MUST_SIT_TOGETHER");
      await rules.addRule(full(b), full(a), "MUST_SIT_TOGETHER");
      await expect(rules.message("That rule already exists for these two guests.")).toBeVisible();
      expect(await weddingData.listRelationships(w)).toHaveLength(1);
    });

    await test.step("Guest CSV import: example, download, empty file, unmappable columns, Cancel", async () => {
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();

      await weddingGuestsPage.importExampleToggle().click();
      await expect(weddingGuestsPage.importExampleTable()).toBeVisible();
      const [download] = await Promise.all([page.waitForEvent("download"), weddingGuestsPage.downloadExampleButton().click()]);
      expect(download.suggestedFilename()).toBe("seatwise-guest-import-example.csv");
      const path = await download.path();
      const text = (await import("node:fs")).readFileSync(path, "utf8");
      expect(text.replace(/^﻿/, "").split(/\r?\n/)[0]).toMatch(/^"?First name"?,/i);
      await weddingGuestsPage.importExampleToggle().click();
      await expect(weddingGuestsPage.importExampleTable()).toHaveCount(0);

      await weddingGuestsPage.chooseImportFile("", "empty.csv");
      await expect(weddingGuestsPage.message("Couldn't find a header row in that file.")).toBeVisible();

      await weddingGuestsPage.chooseImportFile("Colour,Shoe size\nBlue,9\n", "odd.csv");
      await expect(weddingGuestsPage.importMappingHeading()).toBeVisible();
      await expect(weddingGuestsPage.importMappingSelect(/^First name \*$/)).toHaveValue("");
      await expect(weddingGuestsPage.previewImportButtonLocator()).toBeDisabled();
      await weddingGuestsPage.cancelImport();
      await expect(weddingGuestsPage.importMappingHeading()).toHaveCount(0);
      expect(await weddingData.listGuests(w)).toHaveLength(2);
    });

    await test.step("Sign-up: a short password and a taken email are refused", async () => {
      const visitor = await browser.newContext();
      try {
        const signup = new SignupPage(await visitor.newPage());
        await signup.goto();
        // The field requires 8+ characters, so the browser stops a short one before anything is sent.
        const shortEmail = `pw-tester-${uniqueToken(testInfo.workerIndex)}@example.invalid`;
        await signup.signUp("Short Password", shortEmail, "short");
        expect(await signup.passwordValidationMessage()).not.toBe("");
        const login = await visitor.request.post("/api/v1/auth/login", { data: { email: shortEmail, password: "short" } });
        expect(login.ok()).toBe(false);

        const me = ((await (await context.request.get("/api/v1/auth/me")).json()) as { user: { email: string } }).user;
        await signup.signUp("Taken Email", me.email, "a-long-enough-password");
        await signup.expectError("An account with that email already exists");
      } finally {
        await visitor.close();
      }
    });

    await test.step("New wedding from a template with neither part ticked can't be added", async () => {
      const template = await weddingData.saveWeddingAsTemplate(w, uniqueTitle(testInfo.workerIndex, "Guard Template"));
      const dashboard = new DashboardPage(page);
      await dashboard.goto();
      await dashboard.selectTemplate(template.id);
      await dashboard.setApplyTemplateTables(false);
      await dashboard.setApplyTemplateRules(false);
      await expect(dashboard.pickAtLeastOneWarning()).toBeVisible();
      expect(await dashboard.isAddWeddingDisabled()).toBe(true);
      await dashboard.setApplyTemplateRules(true);
      await expect(dashboard.pickAtLeastOneWarning()).toHaveCount(0);
      await dashboard.selectTemplate("");
    });

    await test.step("A new wedding's note is saved", async () => {
      const dashboard = new DashboardPage(page);
      const name = uniqueTitle(testInfo.workerIndex, "Noted Wedding");
      await dashboard.createWedding({ name, note: "Outdoor ceremony, tent on standby" });
      const weddings = ((await (await context.request.get("/api/v1/weddings")).json()) as {
        weddings: { id: string; name: string }[];
      }).weddings;
      const created = weddings.find((x) => x.name === name)!;
      const detail = ((await (await context.request.get(`/api/v1/weddings/${created.id}`)).json()) as {
        wedding: { note: string | null };
      }).wedding;
      expect(detail.note).toBe("Outdoor ceremony, tent on standby");
      await context.request.delete(`/api/v1/weddings/${created.id}`);
    });
  },
);
