/**
 * TS-97 (REQ-BUDGET-VENDOR-TRACKING) — "Add a vendor" suggests vendors from the planner's other
 * weddings as they type a name (Tom's decisions, 2026-10-01). Picking one fills in the name,
 * category and contact details, never the cost, contract notes or arrival time, which belong to
 * each wedding. A brand-new vendor is added exactly as before. Suggestions come only from weddings
 * the planner owns, never from ones they only collaborate on, and the same vendor on several
 * weddings is suggested once.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueTitle, uniqueToken } from "../data/ids.js";
import { WeddingDataSetup } from "../data/api.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

defineQualityTest(
  {
    id: "budget.vendor-suggestions-from-the-planners-other-weddings.pick-fills-contact-not-cost-owned-only-once",
    title: "adding a vendor suggests ones from the planner's own other weddings, once each, filling contact details but never cost or notes",
    objective:
      "Confirms that typing in the Add a vendor name box on a new wedding shows a vendor from another wedding the planner owns; that the same vendor recorded on two of their weddings is suggested once, with its most recent details; that picking it fills the name, category and contact details but leaves cost, contract notes and arrival time empty; that the picked vendor saves with those details; that a vendor from a wedding the planner only collaborates on is never suggested, in the page or in the suggestions API; that the API never returns costs or notes; and that a brand-new vendor is still added normally.",
    expectedOutcome:
      "Typing the shared token shows exactly one suggestion for the florist; picking it fills 'Florist', 'Rosa Newest', 'rosa-new@example.invalid' and '555-0199' with cost, notes and arrival time blank; the saved row shows that contact line and 'No cost set'. The collaborated-on wedding's caterer never appears, and the API response has no costCents, contractNotes or arrivalTime. A brand-new vendor is added with no suggestions shown for it.",
    requirementIds: ["REQ-BUDGET-VENDOR-TRACKING"],
    tags: ["@mutating", "@feature:budget", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, account, page, context, browser }, testInfo) => {
    test.setTimeout(90_000);
    const token = uniqueToken(testInfo.workerIndex);
    const florist = `Bloom ${token} Florals`;
    const caterer = `Bloom ${token} Catering`;

    const postVendor = (request: typeof context.request, weddingId: string, data: Record<string, unknown>) =>
      request.post(`/api/v1/weddings/${weddingId}/vendors`, { data }).then((r) => {
        expect(r.status()).toBe(201);
      });

    // The planner's own past weddings: the same florist on two of them -- first spelled with
    // different capitals and stray spaces, then again later with newer contact details.
    await postVendor(context.request, managedWedding.id, {
      name: `  ${florist.toUpperCase()} `,
      category: "FLORIST",
      contactName: "Rosa Old",
      contactEmail: "rosa-old@example.invalid",
      costCents: 150_000,
      contractNotes: "SECRET-TERMS-A",
      arrivalTime: "14:30",
    });
    const second = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Second Wedding"));
    await postVendor(context.request, second.id, {
      name: florist,
      category: "FLORIST",
      contactName: "Rosa Newest",
      contactEmail: "rosa-new@example.invalid",
      contactPhone: "555-0199",
      costCents: 90_000,
      contractNotes: "SECRET-TERMS-B",
    });

    // Another planner's wedding, on which this planner is only an Edit collaborator.
    const other = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "otherplanner");
    const otherData = new WeddingDataSetup(other.context.request);
    try {
      const theirs = await otherData.createWedding(uniqueTitle(testInfo.workerIndex, "Other Planner Wedding"));
      await postVendor(other.context.request, theirs.id, {
        name: caterer,
        category: "CATERING",
        contactEmail: "their-caterer@example.invalid",
      });
      await otherData.addCollaborator(theirs.id, account.email, "EDIT");

      const fresh = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "New Wedding"));
      const budget = new BudgetTabPage(page);
      await budget.goto(fresh.id);

      await test.step("Typing shows the planner's own past florist once, and never the collaborated-on caterer", async () => {
        await budget.typeVendorName(`bloom ${token.toLowerCase()}`);
        await expect(budget.vendorSuggestion(florist)).toBeVisible();
        await expect(budget.vendorSuggestions()).toHaveCount(1);
        await expect(budget.vendorSuggestion(caterer)).toHaveCount(0);
      });

      await test.step("Picking it fills the name, category and newest contact details, but not cost, notes or arrival", async () => {
        await budget.vendorSuggestion(florist).click();
        await expect(budget.suggestionFilledNotice()).toBeVisible();
        await expect(budget.vendorSuggestions()).toHaveCount(0);
        expect(await budget.addFormValues()).toEqual({
          name: florist,
          category: "Florist",
          contactName: "Rosa Newest",
          contactEmail: "rosa-new@example.invalid",
          contactPhone: "555-0199",
          cost: "",
          contractNotes: "",
          arrivalTime: "",
        });
      });

      await test.step("It saves with those details and no cost", async () => {
        await budget.submitAddVendor();
        await expect(budget.vendorContactLineText(florist)).toHaveText("Rosa Newest · rosa-new@example.invalid · 555-0199");
        await expect(budget.vendorCostText(florist)).toHaveText("No cost set");
      });

      await test.step("Once it's on this wedding it isn't suggested again", async () => {
        await budget.typeVendorName("bloom");
        await expect(budget.vendorSuggestions()).toHaveCount(0);
      });

      await test.step("A brand-new vendor is added normally", async () => {
        const bakery = `Brand New ${token} Bakery`;
        await budget.typeVendorName(bakery);
        await expect(budget.vendorSuggestions()).toHaveCount(0);
        await budget.addVendor({ name: bakery, category: "Cake / Bakery", cost: "400" });
        await expect(budget.vendorCostText(bakery)).toHaveText("$400.00");
      });

      await test.step("The suggestions API returns only owned weddings' vendors, once each, with nothing per-wedding", async () => {
        const res = await context.request.get(`/api/v1/vendor-suggestions?excludeWeddingId=${fresh.id}`);
        expect(res.status()).toBe(200);
        const raw = await res.text();
        const { suggestions } = JSON.parse(raw) as { suggestions: { name: string }[] };
        expect(suggestions.filter((s) => s.name.toLowerCase() === florist.toLowerCase())).toHaveLength(1);
        expect(raw).not.toContain(caterer);
        for (const secret of ["costCents", "contractNotes", "arrivalTime", "SECRET-TERMS", "rosa-old@example.invalid"]) {
          expect(raw).not.toContain(secret);
        }

        const anonymous = await browser.newContext();
        try {
          expect((await anonymous.request.get("/api/v1/vendor-suggestions")).status()).toBe(401);
        } finally {
          await anonymous.close();
        }
      });
    } finally {
      await otherData.cleanupTrackedWeddings();
      await other.context.close();
    }
  },
);
