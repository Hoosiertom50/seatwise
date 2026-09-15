/**
 * TS-51 (REQ-REUSABLE-TEMPLATES) — the API-level combinatorial and edge-case half of this
 * requirement's coverage, complementing
 * portfolio.save-as-template-then-apply-both-pieces-omits-guests-and-relationships.spec.ts's real,
 * both-pieces-checked, UI-driven happy path. Authored directly from `createWeddingSchema`'s own
 * `.superRefine()` (packages/shared/src/schemas/wedding.ts), `createWedding`'s template-apply
 * branch (packages/db/src/queries/weddings.ts, around its `TemplateNotFoundError("Template not
 * found.")` throw), and the two `/api/v1/templates/[templateId]` handlers
 * (apps/web/src/app/api/v1/templates/[templateId]/route.ts).
 *
 * Three independent scenarios, three separate defineQualityTest calls (mirroring this framework's
 * established pattern in rules.side-mixing-levels-change-generation-behavior.spec.ts for
 * unrelated sub-claims that would otherwise entangle a single shared dataset):
 *
 * 1. Apply-flag combinatorics: the superRefine's 422 when templateId is set but both flags are
 *    false; applyTemplateTables alone clones the table layout but never touches sideMixing (which
 *    stays whatever the request itself specified -- the schema default, or an explicit value --
 *    never silently replaced by the template's own KEEP_SEPARATE); applyTemplateRules alone
 *    overwrites sideMixing from the template but clones zero tables.
 * 2. Cross-user ownership scoping (the one place a template's access is checked at all -- it's
 *    never shared, collaborator-visible, or listed for anyone but its owner) and a zero-table
 *    template applying exactly like starting from scratch.
 * 3. Template lifecycle independence from the wedding it started life as a snapshot of: deleting a
 *    template cascades to its own template-table rows (confirmed indirectly -- a subsequent GET
 *    404s the whole template, not just orphaning rows); deleting the *source* wedding does the
 *    opposite -- the template and its tables survive completely untouched (the FK is
 *    `ON DELETE SET NULL` onto the template, not a cascade), only sourceWeddingId/sourceWeddingName
 *    themselves going null.
 *
 * Real finding, asserted precisely below rather than smoothed over with a substring match: the two
 * "not found" paths for a template use inconsistent punctuation -- the direct template-read/delete
 * routes return the exact string "Template not found" (no trailing period), while createWedding's
 * own ownership check (reached only via POST /api/v1/weddings with someone else's templateId)
 * throws "Template not found." (with one). Both are 404s and neither is user-facing copy (no UI
 * flow can ever produce either message -- the dashboard never offers a template it didn't fetch in
 * the first place), so this is a harmless internal inconsistency, not a real bug.
 */

import { request as playwrightRequest } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingDataSetup } from "../data/api.js";
import { signUpFreshAccount } from "../support/auth.js";
import { getEnv } from "../support/env.js";
import { uniqueTitle } from "../data/ids.js";

defineQualityTest(
  {
    id: "portfolio.template-apply-flags-ownership-and-lifecycle-edge-cases.applying-one-piece-at-a-time-never-leaks-the-other",
    title: "creating a wedding from a template with only applyTemplateTables checked clones the tables but never touches sideMixing, only applyTemplateRules checked overwrites sideMixing but clones zero tables, and templateId with both flags false is rejected with the documented validation message",
    objective:
      "Confirms createWeddingSchema's own superRefine rejects a templateId with both apply flags false (422, fieldErrors.templateId, the exact 'Pick at least one...' message) rather than silently applying nothing, and that the two apply flags are genuinely independent: applyTemplateTables alone clones the template's tables while sideMixing stays exactly what the request itself specified (the schema default when omitted, or an explicit value) -- never the template's own KEEP_SEPARATE -- and applyTemplateRules alone overwrites sideMixing from the template while cloning zero tables.",
    expectedOutcome:
      "POST /api/v1/weddings with a templateId and both flags false returns 422 with fieldErrors.templateId containing the exact validation message. With only applyTemplateTables checked and sideMixing omitted, the new wedding has 2 cloned tables and sideMixing BALANCED_MIX (the schema default, not the template's KEEP_SEPARATE); with sideMixing explicitly set to FULLY_MIXED in the same request, it stays FULLY_MIXED. With only applyTemplateRules checked, the new wedding has sideMixing KEEP_SEPARATE (the template's) and 0 tables.",
    requirementIds: ["REQ-REUSABLE-TEMPLATES"],
    tags: ["@mutating", "@feature:templates", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData }, testInfo) => {
    let templateId = "";

    await test.step("Arrange: a source wedding with a non-default Side-Mixing setting and two tables, saved as a template", async () => {
      await weddingData.updateWedding(managedWedding.id, { sideMixing: "KEEP_SEPARATE" });
      await weddingData.createTable(managedWedding.id, { label: "Head Table", capacity: 6 });
      await weddingData.createTable(managedWedding.id, { label: "Kids Corner", capacity: 4 });
      const template = await weddingData.saveWeddingAsTemplate(
        managedWedding.id,
        uniqueTitle(testInfo.workerIndex, "Flags Test Template"),
      );
      expect(template.tables).toHaveLength(2);
      templateId = template.id;
    });

    await test.step("Assert: templateId with both apply flags false (the schema default) is rejected with the exact documented message", async () => {
      const res = await weddingData.createWeddingRaw({
        name: uniqueTitle(testInfo.workerIndex, "Rejected Wedding"),
        templateId,
      });
      expect(res.status).toBe(422);
      expect(res.body.fieldErrors?.templateId).toEqual([
        "Pick at least one part of the template to use: its table layout, its rule-shape, or both.",
      ]);
      expect(res.body.wedding).toBeUndefined();
    });

    await test.step("Assert: applyTemplateTables alone clones the 2 tables, and sideMixing stays the schema default (BALANCED_MIX) -- never the template's KEEP_SEPARATE", async () => {
      const res = await weddingData.createWeddingRaw({
        name: uniqueTitle(testInfo.workerIndex, "Tables Only Default SideMixing"),
        templateId,
        applyTemplateTables: true,
      });
      expect(res.status).toBe(201);
      const wedding = await weddingData.getWedding(res.body.wedding!.id);
      expect(wedding.sideMixing).toBe("BALANCED_MIX");
      const tables = await weddingData.listTables(wedding.id);
      expect(tables).toHaveLength(2);
      expect(tables.map((t) => t.label).sort()).toEqual(["Head Table", "Kids Corner"]);
    });

    await test.step("Assert: applyTemplateTables alone with an explicit sideMixing in the same request keeps that explicit value, not the template's", async () => {
      const res = await weddingData.createWeddingRaw({
        name: uniqueTitle(testInfo.workerIndex, "Tables Only Explicit SideMixing"),
        templateId,
        applyTemplateTables: true,
        sideMixing: "FULLY_MIXED",
      });
      expect(res.status).toBe(201);
      const wedding = await weddingData.getWedding(res.body.wedding!.id);
      expect(wedding.sideMixing).toBe("FULLY_MIXED");
      const tables = await weddingData.listTables(wedding.id);
      expect(tables).toHaveLength(2);
    });

    await test.step("Assert: applyTemplateRules alone overwrites sideMixing from the template but clones zero tables", async () => {
      const res = await weddingData.createWeddingRaw({
        name: uniqueTitle(testInfo.workerIndex, "Rules Only"),
        templateId,
        applyTemplateRules: true,
        // Deliberately set to prove the template's value wins over this one, not just over the
        // schema default.
        sideMixing: "FULLY_MIXED",
      });
      expect(res.status).toBe(201);
      const wedding = await weddingData.getWedding(res.body.wedding!.id);
      expect(wedding.sideMixing).toBe("KEEP_SEPARATE");
      const tables = await weddingData.listTables(wedding.id);
      expect(tables).toHaveLength(0);
    });
  },
);

defineQualityTest(
  {
    id: "portfolio.template-apply-flags-ownership-and-lifecycle-edge-cases.templates-are-scoped-strictly-to-their-owner-and-a-zero-table-template-applies-like-scratch",
    title: "a template is never visible or applicable to any account but the one that saved it, and a template with zero tables applies exactly like starting from scratch",
    objective:
      "Confirms a second, independent account can neither read (GET /api/v1/templates/:id) nor apply (POST /api/v1/weddings with that templateId) the first account's template -- both 404 with 'Template not found' -- and that the second account's own listTemplates() never includes it, while the owning account can successfully apply its own zero-table template (0 tables cloned, guestCount 0, identical to a from-scratch wedding).",
    expectedOutcome:
      "GET /api/v1/templates/:id as the non-owner returns 404 'Template not found'. POST /api/v1/weddings as the non-owner with that templateId and applyTemplateTables true returns 404 'Template not found.' (createWedding's own ownership check). The non-owner's GET /api/v1/templates never lists it. The owner's own zero-table template applies successfully: the new wedding has 0 tables and guestCount 0.",
    requirementIds: ["REQ-REUSABLE-TEMPLATES"],
    tags: ["@mutating", "@feature:templates", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData }, testInfo) => {
    let templateId = "";

    await test.step("Arrange: a source wedding with zero tables, saved as a template", async () => {
      const template = await weddingData.saveWeddingAsTemplate(
        managedWedding.id,
        uniqueTitle(testInfo.workerIndex, "Zero Table Template"),
      );
      expect(template.tables).toHaveLength(0);
      templateId = template.id;
    });

    await test.step("Assert: the owner's own zero-table template applies successfully -- 0 tables, guestCount 0, same as starting from scratch", async () => {
      const res = await weddingData.createWeddingRaw({
        name: uniqueTitle(testInfo.workerIndex, "From Zero Table Template"),
        templateId,
        applyTemplateTables: true,
        applyTemplateRules: true,
      });
      expect(res.status).toBe(201);
      const wedding = await weddingData.getWedding(res.body.wedding!.id);
      expect(wedding.guestCount).toBe(0);
      const tables = await weddingData.listTables(wedding.id);
      expect(tables).toHaveLength(0);
    });

    const baseURL = getEnv().APP_URL;
    const otherCtx = await playwrightRequest.newContext({ baseURL });
    try {
      const otherAccountData = new WeddingDataSetup(otherCtx);

      await test.step("Arrange: a second, entirely independent account", async () => {
        await signUpFreshAccount(otherCtx, testInfo.workerIndex);
      });

      await test.step("Assert: the other account cannot read the first account's template (404, 'Template not found')", async () => {
        const res = await otherAccountData.getTemplateRaw(templateId);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Template not found");
      });

      await test.step("Assert: the other account cannot apply the first account's template either -- createWedding's own ownership check rejects it with a 404, not a permission-based 403", async () => {
        const res = await otherAccountData.createWeddingRaw({
          name: uniqueTitle(testInfo.workerIndex, "Should Never Exist"),
          templateId,
          applyTemplateTables: true,
        });
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Template not found.");
        expect(res.body.wedding).toBeUndefined();
      });

      await test.step("Assert: the other account's own template list never includes the first account's template", async () => {
        const otherTemplates = await otherAccountData.listTemplates();
        expect(otherTemplates.find((t) => t.id === templateId)).toBeUndefined();
      });
    } finally {
      await otherCtx.dispose();
    }
  },
);

defineQualityTest(
  {
    id: "portfolio.template-apply-flags-ownership-and-lifecycle-edge-cases.a-template-outlives-its-source-wedding-but-not-its-own-deletion",
    title: "deleting a template removes it entirely (including its own tables), while deleting the wedding it was saved from leaves the template and its tables completely intact -- only its source-wedding pointer goes null",
    objective:
      "Confirms DELETE /api/v1/templates/:id actually removes the template (a subsequent GET 404s, not just an empty tables array), and that deleting the *source* wedding a different template was saved from does not touch that template at all -- it remains fully readable and applicable, with only sourceWeddingId/sourceWeddingName going null (the FK is ON DELETE SET NULL, not a cascade onto the template).",
    expectedOutcome:
      "After DELETE on templateA, GET on templateA returns 404. After the source wedding is deleted, GET on templateB still returns 200 with its 1 table intact and sourceWeddingId/sourceWeddingName both null.",
    requirementIds: ["REQ-REUSABLE-TEMPLATES"],
    tags: ["@mutating", "@feature:templates", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData }, testInfo) => {
    let templateAId = "";
    let templateBId = "";

    await test.step("Arrange: two templates saved from the same source wedding", async () => {
      await weddingData.createTable(managedWedding.id, { label: "Only Table", capacity: 4 });
      const templateA = await weddingData.saveWeddingAsTemplate(
        managedWedding.id,
        uniqueTitle(testInfo.workerIndex, "To Be Deleted"),
      );
      templateAId = templateA.id;
      const templateB = await weddingData.saveWeddingAsTemplate(
        managedWedding.id,
        uniqueTitle(testInfo.workerIndex, "To Survive Source Deletion"),
      );
      templateBId = templateB.id;
    });

    await test.step("Act + Assert: deleting templateA removes it entirely -- a subsequent read 404s", async () => {
      const deleteRes = await weddingData.deleteTemplateRaw(templateAId);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.ok).toBe(true);

      const readRes = await weddingData.getTemplateRaw(templateAId);
      expect(readRes.status).toBe(404);
      expect(readRes.body.error).toBe("Template not found");
    });

    await test.step("Act: delete the source wedding itself", async () => {
      await weddingData.deleteWedding(managedWedding.id);
    });

    await test.step("Assert: templateB survives its source wedding's deletion completely intact, only its source pointer fields going null", async () => {
      const res = await weddingData.getTemplateRaw(templateBId);
      expect(res.status).toBe(200);
      const template = res.body.template!;
      expect(template.sourceWeddingId).toBeNull();
      expect(template.sourceWeddingName).toBeNull();
      expect(template.tables).toHaveLength(1);
      expect(template.tables[0].label).toBe("Only Table");
    });
  },
);
