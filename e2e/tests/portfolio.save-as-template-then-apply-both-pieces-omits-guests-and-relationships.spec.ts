/**
 * TS-51 (REQ-REUSABLE-TEMPLATES) — no manual test case or numbered acceptance criterion exists for
 * this requirement (the acceptance-test workbook predates TS-19's planner-pivot roadmap); authored
 * directly from `quality/requirements.yaml`'s REQ-REUSABLE-TEMPLATES description ("a planner can
 * save a wedding's table layout and rules as a reusable template") plus README.md's FR-14.1-14.4
 * writeup and the live implementation (`packages/db/src/queries/templates.ts`,
 * `packages/db/src/queries/weddings.ts`'s `createWedding`, and the two UI entry points on
 * `TablesTab.tsx` and `dashboard/page.tsx`).
 *
 * The single most important real finding here, confirmed directly against the save/apply code
 * (`createTemplateFromWedding` in templates.ts, and its own model comment in schema.prisma): a
 * template is guest-agnostic by design. Saving one never captures any guest, any
 * GuestRelationship (Must/Must-Not-Sit-Together, Prefer Near, Avoid), or even a Restricted table's
 * own `requiredGuestIds` list -- only structural, guest-independent table fields (label, capacity,
 * shape, isRestricted/isAccessible/isLocked flags, Purpose-table criterion) plus the wedding's
 * Side-Mixing setting ("rule-shape", FR-14.2). This test proves that boundary concretely: a source
 * wedding with real guests, a real relationship, and a Restricted table with a real required-guest
 * list produces a template that carries none of it, and a wedding created from that template with
 * both template pieces applied starts with zero guests despite inheriting the exact table layout.
 *
 * Drives both halves through the real UI (TablesTab's "Save as a reusable template" section, and
 * the dashboard create-wedding form's "Start from a template" picker) rather than only the API, so
 * this also covers FR-14.1's actual UI copy/labels and the picker's own
 * `"{name} ({n} tables · from {source})"` option format -- not just the underlying contract.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { uniqueTitle, uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "portfolio.save-as-template-then-apply-both-pieces-omits-guests-and-relationships.full-round-trip-through-the-real-ui",
    title: "saving a wedding as a template through the real UI captures its table layout and Side-Mixing setting but never a guest, a relationship, or a Restricted table's required-guest list, and applying both pieces to a new wedding through the real UI reproduces the tables and rule-shape while starting with zero guests",
    objective:
      "Confirms the 'Save as a reusable template' form on the Tables tab snapshots exactly the source wedding's table structure and Side-Mixing setting -- never any guest, GuestRelationship, or a Restricted table's requiredGuestIds -- and that selecting the resulting template on the dashboard's create-wedding form with both 'Use its table layout' and 'Use its rule-shape' checked produces a new wedding with matching tables (fresh ids, no required-guest list) and the template's Side-Mixing setting, but guestCount 0.",
    expectedOutcome:
      "The Tables tab shows the exact 'Saved \"{name}\" (2 tables) — pick it when creating a new wedding from your dashboard.' success text. The template detail (GET /api/v1/templates/:id) has 2 tables matching the source's structural fields exactly, sideMixing KEEP_SEPARATE, and no requiredGuestIds/guest/relationship data anywhere. The dashboard's template picker option reads '{name} (2 tables · from {sourceWeddingName})'. The newly created wedding has sideMixing KEEP_SEPARATE, guestCount 0, and 2 tables matching the template's tables (new ids, empty requiredGuestIds each).",
    requirementIds: ["REQ-REUSABLE-TEMPLATES"],
    tags: ["@mutating", "@feature:templates", "@feature:portfolio", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const templateName = uniqueTitle(testInfo.workerIndex, "Standard Reception Layout");
    const newWeddingName = uniqueTitle(testInfo.workerIndex, "Seeded Wedding");
    const guestA = uniquePersonName(testInfo.workerIndex);
    const guestB = uniquePersonName(testInfo.workerIndex);

    let restrictedTableId = "";

    const context = page.context();

    await test.step("Arrange: set the source wedding's Side-Mixing to a non-default value", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}`, {
        data: { sideMixing: "KEEP_SEPARATE" },
      });
      expect(res.status()).toBe(200);
    });

    const guests = { a: { id: "" }, b: { id: "" } };
    await test.step("Arrange: two guests and a Must-Sit-Together relationship between them", async () => {
      const createdA = await weddingData.createGuest(managedWedding.id, guestA);
      const createdB = await weddingData.createGuest(managedWedding.id, guestB);
      guests.a.id = createdA.id;
      guests.b.id = createdB.id;
      await weddingData.createRelationship(managedWedding.id, createdA.id, createdB.id, "MUST_SIT_TOGETHER");
    });

    await test.step("Arrange: a plain accessible table and a Restricted, Age-Category Purpose table with a real required-guest list", async () => {
      await weddingData.createTable(managedWedding.id, {
        label: "Head Table",
        capacity: 6,
        isAccessible: true,
        shape: "RECTANGULAR",
      });
      const restricted = await weddingData.createTable(managedWedding.id, {
        label: "Kids Corner",
        capacity: 4,
        isRestricted: true,
        purpose: "Kids Table",
        purposeCriterionType: "AGE_CATEGORY",
        purposeCriterionValue: "CHILD",
      });
      restrictedTableId = restricted.id;
      await weddingData.setRequiredGuests(managedWedding.id, restrictedTableId, [guests.a.id]);
    });

    const tablesTabPage = new TablesTabPage(page);
    await test.step("Act (real UI): save the wedding as a template from the Tables tab", async () => {
      await tablesTabPage.goto(managedWedding.id);
      await tablesTabPage.openTablesTab();
      await tablesTabPage.saveAsTemplate(templateName);
    });

    let templateId = "";
    await test.step("Assert: the template captured exactly the table structure and Side-Mixing setting, and nothing guest-related", async () => {
      const templates = await weddingData.listTemplates();
      const summary = templates.find((t) => t.name === templateName);
      expect(summary).toBeTruthy();
      expect(summary!.tableCount).toBe(2);
      expect(summary!.sideMixing).toBe("KEEP_SEPARATE");
      expect(summary!.sourceWeddingName).toBe(managedWedding.name);
      templateId = summary!.id;

      const detailRes = await weddingData.getTemplateRaw(templateId);
      expect(detailRes.status).toBe(200);
      const template = detailRes.body.template!;
      expect(template.tables).toHaveLength(2);

      // ORDER BY label at save time: "Head Table" < "Kids Corner".
      const [headTable, kidsTable] = template.tables;
      expect(headTable.label).toBe("Head Table");
      expect(headTable.capacity).toBe(6);
      expect(headTable.isAccessible).toBe(true);
      expect(headTable.isRestricted).toBe(false);
      expect(headTable.shape).toBe("RECTANGULAR");

      expect(kidsTable.label).toBe("Kids Corner");
      expect(kidsTable.capacity).toBe(4);
      expect(kidsTable.isRestricted).toBe(true);
      expect(kidsTable.purpose).toBe("Kids Table");
      expect(kidsTable.purposeCriterionType).toBe("AGE_CATEGORY");
      expect(kidsTable.purposeCriterionValue).toBe("CHILD");

      // Real finding: a Restricted table's requiredGuestIds is never part of the template shape at
      // all -- not merely empty, structurally absent -- and neither the template nor its tables
      // carry any other guest-shaped field.
      expect("requiredGuestIds" in kidsTable).toBe(false);
      expect(JSON.stringify(template)).not.toContain(guests.a.id);
      expect(JSON.stringify(template)).not.toContain(guests.b.id);
    });

    const dashboardPage = new DashboardPage(page);
    await test.step("Assert (real UI): the dashboard's template picker offers the new template with the exact documented label format", async () => {
      await dashboardPage.goto();
      const optionTexts = await dashboardPage.templateOptionTexts();
      expect(optionTexts).toContain(`${templateName} (2 tables · from ${managedWedding.name})`);
    });

    await test.step("Act (real UI): create a new wedding from the template with both pieces applied", async () => {
      await dashboardPage.selectTemplate(templateId);
      // Both apply checkboxes default to checked -- left as-is, matching "use the whole template".
      await dashboardPage.createWedding({ name: newWeddingName });
      await dashboardPage.openWedding(newWeddingName);
    });

    await test.step("Assert: the new wedding has the template's Side-Mixing setting, zero guests, and matching tables under fresh ids with no required-guest list", async () => {
      const newWeddingId = page.url().split("/weddings/")[1];
      expect(newWeddingId).toBeTruthy();

      const newWedding = await weddingData.getWedding(newWeddingId);
      expect(newWedding.sideMixing).toBe("KEEP_SEPARATE");
      expect(newWedding.guestCount).toBe(0);

      const newTables = await weddingData.listTables(newWeddingId);
      expect(newTables).toHaveLength(2);

      const newHeadTable = newTables.find((t) => t.label === "Head Table")!;
      const newKidsTable = newTables.find((t) => t.label === "Kids Corner")!;
      expect(newHeadTable).toBeTruthy();
      expect(newHeadTable.id).not.toBe("Head Table"); // sanity: a real distinct id, not a label echo
      expect(newHeadTable.capacity).toBe(6);
      expect(newHeadTable.isAccessible).toBe(true);
      expect(newHeadTable.shape).toBe("RECTANGULAR");

      expect(newKidsTable).toBeTruthy();
      expect(newKidsTable.isRestricted).toBe(true);
      expect(newKidsTable.purposeCriterionType).toBe("AGE_CATEGORY");
      expect(newKidsTable.purposeCriterionValue).toBe("CHILD");
      // Real finding: the flag itself (isRestricted) carries over, but there is no guest to
      // require -- the cloned table always starts with an empty required-guest list.
      expect(newKidsTable.requiredGuestIds).toEqual([]);
    });
  },
);
