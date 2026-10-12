/**
 * TS-222 / TS-223 / TS-225 — fixes from the eighth review.
 * - A guest file column whose header starts with + - = or @ (e.g. "+1") is imported, not silently
 *   dropped; a Side name that disagrees with the Side code is a warning (the code is used).
 * - Preview row numbers and the older-Mac-format message use the spreadsheet's numbering.
 * - "Log out on all devices" from a tab whose session already ended says so instead of "done".
 * - The Budget tab shows an arrival before 5:00 AM as "(next day)", as the vendor sees it.
 * - The export buttons and the details form's Save keep keyboard focus when they fail.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueToken } from "../data/ids.js";
import { failRequests } from "../support/networkFaults.js";
import { AccountPage } from "../pages/AccountPage.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";

defineQualityTest(
  {
    id: "cross-cutting.review-8-imports-sign-out-and-small-fixes-hold.plus-one-column-and-side-code",
    title: "an import's \"+1\" column keeps the plus-ones, and a Side name that disagrees with the Side code is only a warning",
    objective:
      "Uploads on the Guests tab a file with columns firstName, lastName, headcount, +1, side and Side code, maps Plus-ones to '+1', and imports it. Confirms the guest is saved with the plus-ones from the '+1' column, and that a row whose Side cell says 'Bride' while its Side code says GROOM is shown as a new row with a warning that the Side code is used (no error), and is saved on the GROOM side.",
    expectedOutcome:
      "The preview shows 2 new and 0 with errors; the second guest's row reads 'doesn't match Side code \"GROOM\"' and 'the Side code is used (Groom)', and doesn't mention clearing the Side code. After importing, the first guest has plusOneNames 'Sam Lee' and headcount 2, and the second guest's side is GROOM.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, context, page }, testInfo) => {
    const w = managedWedding.id;
    const suffix = uniqueToken(testInfo.workerIndex);
    const savedGuests = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}/guests`)).json()) as {
        guests: { lastName: string; side: string; headcount: number; plusOneNames: string | null }[];
      }).guests;
    const guests = new WeddingGuestsPage(page);
    const file =
      "firstName,lastName,headcount,+1,side,Side code\r\n" +
      `Ana,Plus-${suffix},2,Sam Lee,,\r\n` +
      `Bo,Side-${suffix},1,,Bride,GROOM\r\n`;

    await test.step("Map Plus-ones to the '+1' column and preview", async () => {
      await guests.goto(w);
      await guests.chooseImportFile(file);
      await guests.importMappingSelect(/^Plus-ones$/).selectOption("+1");
      await guests.previewImportButtonLocator().click();
      await expect(guests.importPreviewSummary()).toContainText("2 new");
      await expect(guests.importPreviewErrorCountText()).toContainText("0 with errors");
      const sideRow = guests.importPreviewRow(`Bo Side-${suffix}`);
      await expect(sideRow).toContainText('doesn\'t match Side code "GROOM"');
      await expect(sideRow).toContainText("the Side code is used (Groom)");
      await expect(sideRow).not.toContainText(/clear/i);
    });

    await test.step("Import: the plus-ones and the Side code's side are saved", async () => {
      await guests.confirmImport();
      const saved = await savedGuests();
      const ana = saved.find((g) => g.lastName === `Plus-${suffix}`)!;
      expect(ana.plusOneNames).toBe("Sam Lee");
      expect(ana.headcount).toBe(2);
      expect(saved.find((g) => g.lastName === `Side-${suffix}`)!.side).toBe("GROOM");
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-8-imports-sign-out-and-small-fixes-hold.spreadsheet-row-numbers",
    title: "import preview rows and the older-Mac-format message use the spreadsheet's row numbers",
    objective:
      "Uploads a file whose first guest row has no last name and confirms the preview shows it as 'Row 2' (the header is row 1). Then uploads a windows-1252 file whose second guest is 'MŸller' (Müller saved in the older Mac format) and confirms the refusal names row 3.",
    expectedOutcome:
      "The error row is labelled 'Row 2' and says 'Missing required name'; no row is labelled 'Row 1'. The Mac file is refused with a message containing 'older Mac format' and '(First seen in row 3, column \"lastName\".)'.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }, testInfo) => {
    const guests = new WeddingGuestsPage(page);
    const suffix = uniqueToken(testInfo.workerIndex);
    await guests.goto(managedWedding.id);

    await test.step("The first guest row is Row 2", async () => {
      await guests.importGuestsFromCsvAndPreview(`firstName,lastName\r\nAna,\r\nBo,Lee-${suffix}\r\n`);
      await expect(guests.importPreviewRowNumber(2)).toContainText("Missing required name");
      await expect(guests.importPreviewRowNumber(1)).toHaveCount(0);
      await expect(guests.importPreviewRowNumber(3)).toContainText(`Bo Lee-${suffix}`);
      await guests.cancelImport();
    });

    await test.step("The older Mac format is refused naming the spreadsheet row", async () => {
      // 0x9F is "Ÿ" in windows-1252 -- Mac Roman's "ü".
      const bytes = Buffer.concat([
        Buffer.from(`firstName,lastName\r\nAna,Lee-${suffix}\r\nAnna,M`, "latin1"),
        Buffer.from([0x9f]),
        Buffer.from(`ller-${suffix}\r\n`, "latin1"),
      ]);
      await guests.chooseImportFileBytes(bytes);
      await guests.previewImportButtonLocator().click();
      await expect(guests.importError("older Mac format")).toContainText('(First seen in row 3, column "lastName".)');
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-8-imports-sign-out-and-small-fixes-hold.log-out-everywhere-from-an-ended-session",
    title: "Log out on all devices from a tab whose session already ended says to sign in again, instead of claiming it worked",
    objective:
      "Opens the Account page signed in, then ends this browser's session from the same browser (as Log out in another tab does). Confirms that pressing Log out on all devices answers 401, stays on the Account page and shows the message to sign in again with a Sign in link, while another browser signed in to the same account stays signed in.",
    expectedOutcome:
      "The logout request answers 401; the page stays on /account and the section shows \"You're already signed out here — sign in again, then use Log out on all devices.\" with a 'Sign in' link; the second browser's /auth/me still answers 200.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser, playwright, baseURL }, testInfo) => {
    // One account signed in on two browsers (as in auth.log-out-this-device-or-every-device).
    const token = uniqueToken(testInfo.workerIndex);
    const email = `pw-tester-logout-ended-${token}@example.invalid`;
    const password = randomBytes(16).toString("base64url");
    const setup = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    expect((await setup.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password } })).status()).toBe(201);
    await setup.dispose();
    const [here, other] = await Promise.all(
      [1, 2].map(async () => {
        const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
        expect((await ctx.request.post("/api/v1/auth/login", { data: { email, password } })).status()).toBe(200);
        return ctx;
      }),
    );
    try {
      const page = await here.newPage();
      const account = new AccountPage(page);
      await account.goto();

      await test.step("This browser's session ends in another tab", async () => {
        expect((await here.request.post("/api/v1/auth/logout")).status()).toBe(200);
      });

      await test.step("Log out on all devices says to sign in again, and nothing claims it worked", async () => {
        expect(await account.pressLogOutEverywhere()).toBe(401);
        await expect(account.logOutEverywhereMessage()).toContainText(
          "You're already signed out here — sign in again, then use Log out on all devices.",
        );
        await expect(account.logOutEverywhereSignInLink()).toBeVisible();
        expect(new URL(page.url()).pathname).toBe("/account");
        expect((await other.request.get("/api/v1/auth/me")).status()).toBe(200);
      });
    } finally {
      await here.close();
      await other.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-8-imports-sign-out-and-small-fixes-hold.budget-arrival-next-day",
    title: "the Budget tab shows a vendor arriving before 5:00 AM as \"(next day)\", as the vendor sees it",
    objective:
      "Adds two vendors through the API, arriving at 04:30 and 10:00, and confirms the Budget tab's vendor rows read 'Arrives 4:30 AM (next day)' and 'Arrives 10:00 AM'.",
    expectedOutcome: "The early vendor's row reads 'Arrives 4:30 AM (next day)'; the other reads 'Arrives 10:00 AM'.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:budget", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, context, page }) => {
    const base = `/api/v1/weddings/${managedWedding.id}`;
    for (const v of [
      { name: "Early Shuttle", category: "TRANSPORTATION", arrivalTime: "04:30" },
      { name: "Day Florist", category: "FLORIST", arrivalTime: "10:00" },
    ]) {
      expect((await context.request.post(`${base}/vendors`, { data: v })).status()).toBe(201);
    }
    const budget = new BudgetTabPage(page);
    await budget.goto(managedWedding.id);
    await expect(budget.vendorArrivalText("Early Shuttle")).toHaveText("Arrives 4:30 AM (next day)");
    await expect(budget.vendorArrivalText("Day Florist")).toHaveText("Arrives 10:00 AM");
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-8-imports-sign-out-and-small-fixes-hold.failed-exports-and-saves-keep-focus",
    title: "a failed PDF or CSV export, or a refused details save, leaves keyboard focus on the button that was pressed",
    objective:
      "With the server made to fail each request once, presses with the keyboard (Enter) the Seating plan tab's 'Seating chart (PDF)', the Guests tab's 'Export guest list (CSV)', and a guest's 'Save details' after changing the party size. Confirms each shows its error and that keyboard focus is still on the button pressed.",
    expectedOutcome:
      "Each press shows an alert with 'Something went wrong' (the details form's alert for the save), and afterwards 'Seating chart (PDF)', 'Export guest list (CSV)' and 'Save details' are each the focused element.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:export", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    await weddingData.createGuest(w, name);
    await weddingData.quickCreateTables(w, { count: 1, capacity: 8 });
    const generated = await weddingData.generatePlanVersion(w);
    expect((await weddingData.setPlanVersionStatus(w, generated.id, "APPROVED")).status).toBe(200);

    await test.step("A failed PDF export keeps focus on its button", async () => {
      const plan = new PlanTabPage(page);
      await plan.goto(w);
      const fault = await failRequests(page, /\/export\/chart(\?|$)/, "GET", { status: 500, error: "Something went wrong" }, 1);
      const button = plan.exportButton("Seating chart (PDF)");
      await button.focus();
      const popup = page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null);
      await page.keyboard.press("Enter");
      await expect(plan.exportError("Something went wrong")).toBeVisible();
      const opened = await popup;
      if (opened && !opened.isClosed()) await opened.close();
      await expect(button).toBeFocused();
      expect(fault.hits).toBe(1);
      await fault.clear();
    });

    const guests = new WeddingGuestsPage(page);
    await test.step("A failed CSV export keeps focus on its button", async () => {
      await guests.goto(w);
      const fault = await failRequests(page, "**/guests/export", "GET", { status: 500, error: "Something went wrong" }, 1);
      await guests.exportCsvLink().focus();
      await page.keyboard.press("Enter");
      await expect(guests.exportCsvError("Something went wrong")).toBeVisible();
      await expect(guests.exportCsvLink()).toBeFocused();
      await fault.clear();
    });

    await test.step("A refused details save keeps focus on Save details", async () => {
      const row = guests.guestRow(`${name.firstName} ${name.lastName}`);
      await row.openDetails();
      await row.fillDetails({ headcount: "3" });
      const fault = await failRequests(page, /\/api\/v1\/weddings\/[^/]+\/guests\/[^/]+$/, "PATCH", { status: 500, error: "Something went wrong" }, 1);
      await row.saveDetailsButton().focus();
      await page.keyboard.press("Enter");
      await expect(row.detailsError()).toBeVisible();
      await expect(row.saveDetailsButton()).toBeFocused();
      await fault.clear();
    });
  },
);
