/**
 * TS-52 (REQ-BUDGET-VENDOR-TRACKING) — no manual test case or numbered acceptance criterion exists
 * for this requirement (it postdates the acceptance-test workbook, same as every other TS-16+
 * planner-pivot story); authored directly from `quality/requirements.yaml`'s
 * REQ-BUDGET-VENDOR-TRACKING description, README.md's own TS-20 dev-log entry, and the live
 * implementation (`packages/db/src/queries/vendors.ts`, the vendor/budget zod schemas, and
 * `BudgetTab.tsx`).
 *
 * Two scenarios, two separate defineQualityTest calls (mirroring this codebase's established
 * pattern for unrelated sub-claims -- see rules.side-mixing-levels-change-generation-behavior.spec.ts):
 *
 * 1. The full vendor lifecycle through the real UI (add an OTHER-category vendor with every
 *    optional field filled in, confirm the rollup math, push it over budget, edit it back under
 *    budget, then remove it with no confirmation dialog) -- proving both the CRUD surface and the
 *    running-total/remaining math (`getBudgetSummaryForWedding`: totalCostCents sums costCents with
 *    nulls treated as 0; remainingCents is null only while no budget is set, and goes negative
 *    rather than clamping at zero once costs exceed it) actually agree with each other end to end.
 * 2. View and Comment collaborators (View/Comment/Edit is the same ladder every other tab uses --
 *    nothing budget-specific) can read but never mutate a vendor or the budget figure, and their
 *    own Budget tab shows the read-only banner with every add/edit/remove control entirely absent.
 *
 * Real finding, confirmed directly in the JSX and asserted below via BudgetTabPage's own row
 * locators (see that page object's header comment for the full reasoning): a vendor row's name and
 * its category badge render as adjacent children with no separating whitespace
 * (`{v.name}<span>{categoryLabel}</span>`), so a badge is never independently distinguishable from
 * the name by an exact-text match -- this test reads the badge through its own scoped locator
 * rather than assuming a space that doesn't exist in the rendered DOM.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { uniqueToken } from "../data/ids.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";

defineQualityTest(
  {
    id: "budget.vendor-crud-and-rollup-math-through-the-real-ui.full-lifecycle-and-over-budget-math",
    title: "adding, editing, and removing a vendor through the real UI keeps the budget rollup (recorded total, remaining, over-budget warning) correct at every step, with no delete confirmation dialog",
    objective:
      "Confirms the Budget tab's empty state, an OTHER-category vendor's full field set (including its free-text category label appearing as the row's own badge instead of the literal word 'Other'), the three rollup stats (Budget/Recorded so far/Remaining) and the over-budget warning all reflect the real, server-computed totals correctly through add, an inline edit that changes both cost and category, and a confirmation-free remove.",
    expectedOutcome:
      "Starting empty: 'No vendors recorded yet.', 'Vendors (0)', Budget 'Not set', Recorded so far $0.00, Remaining '—'. After adding a $150 OTHER-category vendor labeled 'Officiant' and setting the budget to $100: the row shows the 'Officiant' badge (not 'Other'), Recorded so far $150.00, Remaining -$50.00 in red with the exact over-budget warning text. After editing the vendor's cost down to $50 and its category to Catering: the badge reads 'Catering', Remaining $50.00, no warning. After removing it (a single click, no dialog): back to the empty state and Remaining $100.00.",
    requirementIds: ["REQ-BUDGET-VENDOR-TRACKING"],
    tags: ["@mutating", "@feature:budget", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, page }, testInfo) => {
    const vendorName = `Vendor ${uniqueToken(testInfo.workerIndex)}`;
    const budgetTab = new BudgetTabPage(page);

    await test.step("Act: open the Budget tab", async () => {
      await budgetTab.goto(managedWedding.id);
    });

    await test.step("Assert: the empty state shows no vendors and an unset budget", async () => {
      await expect(budgetTab.emptyState()).toBeVisible();
      await expect(budgetTab.vendorsHeading(0)).toBeVisible();
      await expect(budgetTab.budgetText()).toHaveText("Not set");
      await expect(budgetTab.recordedSoFarText()).toHaveText("$0.00");
      await expect(budgetTab.remainingText()).toHaveText("—");
    });

    await test.step("Act: add an OTHER-category vendor with every optional field filled in", async () => {
      await budgetTab.addVendor({
        name: vendorName,
        category: "Other",
        categoryOther: "Officiant",
        contactName: "Jordan Lee",
        contactEmail: "jordan@example.invalid",
        contactPhone: "555-0100",
        cost: "150",
        contractNotes: "50% deposit due 30 days before, final due day-of",
      });
    });

    await test.step("Assert: the vendor row shows its free-text category label (not the literal word 'Other'), full contact line, notes, and cost; the rollup reflects the new cost with no budget set yet", async () => {
      await expect(budgetTab.vendorsHeading(1)).toBeVisible();
      await expect(budgetTab.emptyState()).toHaveCount(0);
      await expect(budgetTab.vendorCategoryBadgeText(vendorName)).toHaveText("Officiant");
      await expect(budgetTab.vendorContactLineText(vendorName)).toHaveText(
        "Jordan Lee · jordan@example.invalid · 555-0100",
      );
      await expect(budgetTab.vendorNotesText(vendorName)).toHaveText(
        "50% deposit due 30 days before, final due day-of",
      );
      await expect(budgetTab.vendorCostText(vendorName)).toHaveText("$150.00");
      await expect(budgetTab.recordedSoFarText()).toHaveText("$150.00");
      await expect(budgetTab.remainingText()).toHaveText("—");
    });

    await test.step("Act: set the overall budget below the recorded cost", async () => {
      await budgetTab.saveBudget("100");
    });

    await test.step("Assert: Remaining goes negative (never clamped at zero) and the exact over-budget warning appears", async () => {
      await expect(budgetTab.budgetText()).toHaveText("$100.00");
      await expect(budgetTab.recordedSoFarText()).toHaveText("$150.00");
      await expect(budgetTab.remainingText()).toHaveText("-$50.00");
      await expect(budgetTab.overBudgetWarning()).toBeVisible();
      await expect(budgetTab.overBudgetWarning()).toHaveText(
        "Recorded vendor costs are over budget by $50.00.",
      );
    });

    await test.step("Act: edit the vendor's cost down and its category back to a plain (non-OTHER) one", async () => {
      await budgetTab.startEdit(vendorName);
      await budgetTab.setEditCost("50");
      await budgetTab.setEditCategory("Catering");
      await budgetTab.saveEdit();
    });

    await test.step("Assert: the badge now reads the plain category label, and the rollup is back under budget with no warning", async () => {
      await expect(budgetTab.vendorCategoryBadgeText(vendorName)).toHaveText("Catering");
      await expect(budgetTab.vendorCostText(vendorName)).toHaveText("$50.00");
      await expect(budgetTab.recordedSoFarText()).toHaveText("$50.00");
      await expect(budgetTab.remainingText()).toHaveText("$50.00");
      await expect(budgetTab.overBudgetWarning()).toHaveCount(0);
    });

    await test.step("Act: remove the vendor -- a single click, no confirmation dialog of any kind", async () => {
      await budgetTab.remove(vendorName);
    });

    await test.step("Assert: back to the empty vendor state, and Remaining reflects zero recorded cost against the still-set budget", async () => {
      await expect(budgetTab.emptyState()).toBeVisible();
      await expect(budgetTab.vendorsHeading(0)).toBeVisible();
      await expect(budgetTab.recordedSoFarText()).toHaveText("$0.00");
      await expect(budgetTab.remainingText()).toHaveText("$100.00");
    });
  },
);

defineQualityTest(
  {
    id: "budget.vendor-crud-and-rollup-math-through-the-real-ui.view-and-comment-collaborators-cannot-mutate",
    title: "View and Comment collaborators can see the vendor list and budget figures but cannot add, edit, or remove a vendor or change the budget -- their own UI shows a read-only notice instead of the editing controls",
    objective:
      "Confirms a View collaborator and a Comment collaborator (Comment sits below Edit on the same access ladder every other tab uses) are both denied every vendor/budget mutation -- create, edit, remove a vendor, and set the budget -- with a 403, while still able to read both (200), and that their own Budget tab renders the exact read-only notice text with no add-vendor form, no budget-input field, and no per-vendor Edit/Remove controls.",
    expectedOutcome:
      "For both collaborator levels: POST/PATCH/DELETE against vendors and PATCH against budget all return 403, while GET on both still returns 200 with the existing vendor visible. Their own Budget tab shows the exact view-only notice and the add-vendor name input, the budget input, and every Edit/Remove button are absent from the page.",
    requirementIds: ["REQ-BUDGET-VENDOR-TRACKING"],
    tags: ["@mutating", "@feature:budget", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    const token = testInfo.workerIndex;
    const existingVendorName = `Existing Vendor ${uniqueToken(token)}`;
    let existingVendorId = "";

    await test.step("Arrange: one existing vendor for the collaborators to read but not touch", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/vendors`, {
        data: { name: existingVendorName, category: "VENUE" },
      });
      expect(res.status()).toBe(201);
      existingVendorId = ((await res.json()) as { vendor: { id: string } }).vendor.id;
    });

    const viewSession = await signUpFreshAccountInNewContext(browser, token, "budget-view");
    const commentSession = await signUpFreshAccountInNewContext(browser, token, "budget-comment");

    try {
      await test.step("Arrange: a View collaborator and a Comment collaborator on the wedding", async () => {
        await weddingData.addCollaborator(managedWedding.id, viewSession.email, "VIEW");
        await weddingData.addCollaborator(managedWedding.id, commentSession.email, "COMMENT");
      });

      for (const [label, session] of [
        ["View", viewSession],
        ["Comment", commentSession],
      ] as const) {
        await test.step(`Assert: the ${label} collaborator can read vendors and the budget but is denied every mutation`, async () => {
          const vendorsGet = await session.context.request.get(`/api/v1/weddings/${managedWedding.id}/vendors`);
          expect(vendorsGet.status()).toBe(200);
          const vendorsBody = (await vendorsGet.json()) as { vendors: { name: string }[] };
          expect(vendorsBody.vendors.some((v) => v.name === existingVendorName)).toBe(true);

          const budgetGet = await session.context.request.get(`/api/v1/weddings/${managedWedding.id}/budget`);
          expect(budgetGet.status()).toBe(200);

          const createRes = await session.context.request.post(`/api/v1/weddings/${managedWedding.id}/vendors`, {
            data: { name: `${label} attempt ${uniqueToken(token)}`, category: "CATERING" },
          });
          expect(createRes.status()).toBe(403);

          const patchRes = await session.context.request.patch(
            `/api/v1/weddings/${managedWedding.id}/vendors/${existingVendorId}`,
            { data: { name: `${label} edited it` } },
          );
          expect(patchRes.status()).toBe(403);

          const deleteRes = await session.context.request.delete(
            `/api/v1/weddings/${managedWedding.id}/vendors/${existingVendorId}`,
          );
          expect(deleteRes.status()).toBe(403);

          const budgetPatchRes = await session.context.request.patch(
            `/api/v1/weddings/${managedWedding.id}/budget`,
            { data: { budgetCents: 1000 } },
          );
          expect(budgetPatchRes.status()).toBe(403);
        });
      }

      await test.step("Assert (UI): the Comment collaborator's own Budget tab shows the read-only notice, with no add-vendor form, no budget input, and no per-vendor controls", async () => {
        const commentPage = await commentSession.context.newPage();
        const budgetTab = new BudgetTabPage(commentPage);
        await budgetTab.goto(managedWedding.id);

        await expect(budgetTab.viewOnlyNotice()).toBeVisible();
        await expect(budgetTab.budgetInputLocator()).toHaveCount(0);
        await expect(budgetTab.vendorNameInputLocator()).toHaveCount(0);
        await expect(budgetTab.allEditButtons()).toHaveCount(0);
        await expect(budgetTab.allRemoveButtons()).toHaveCount(0);
        // The existing vendor is still visible -- read access is intact, only editing is hidden.
        await expect(budgetTab.textLocator(existingVendorName, false)).toBeVisible();

        await commentPage.close();
      });

      // Confirms the mutations attempted above truly changed nothing.
      await test.step("Assert: the vendor list is untouched after every denied attempt", async () => {
        const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/vendors`);
        const body = (await res.json()) as { vendors: { id: string; name: string }[] };
        expect(body.vendors).toHaveLength(1);
        expect(body.vendors[0].id).toBe(existingVendorId);
        expect(body.vendors[0].name).toBe(existingVendorName);
      });
    } finally {
      await viewSession.context.close();
      await commentSession.context.close();
    }
  },
);
