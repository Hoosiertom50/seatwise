/**
 * TS-205 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — one account can no longer fill the database through a
 * wedding: tables stop at 300 (with a plain message, also from Quick create), old plan versions are
 * pruned past 50 (never the approved or current one), Generate is limited per account per hour,
 * and (TS-204) a body too big is refused before it's read.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { uniquePersonName } from "../data/ids.js";

const TABLE_CAP_MESSAGE =
  "A wedding can have up to 300 tables, and this one has reached that — remove some tables before adding more.";
const GENERATE_LIMIT_MESSAGE = "You've made a lot of seating plans in the last hour — please wait a while and try again.";

defineQualityTest(
  {
    id: "cross-cutting.weddings-have-size-limits.tables-versions-generate-and-body-size",
    title: "a wedding stops at 300 tables, keeps at most 50 plan versions (never the approved one), Generate is limited per hour, and an oversized body is refused",
    objective:
      "Confirms (TS-205) that with 300 tables, Quick create on the Tables tab shows 'A wedding can have up to 300 tables...' and adds nothing, and adding one table through the API is refused (422) with the same words; that after 51 Generates with the first version approved, 50 versions are kept and the approved one is among them; that the 61st Generate within the hour is refused (429) with a plain message; and (TS-204) that a 5 MB body to a wedding route is refused (413).",
    expectedOutcome:
      "Quick create shows the cap message and the table count stays 300; POST /tables answers 422 with the cap message. After 51 Generates: 50 versions listed, version 1 (Approved) still listed. Generates 52-60 succeed, the 61st answers 429 with the hourly-limit message. The 5 MB POST answers 413.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:tables", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    test.setTimeout(180_000);
    const w = managedWedding.id;

    await test.step("Arrange: two guests and 300 tables", async () => {
      for (let i = 0; i < 2; i++) await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      for (let i = 0; i < 3; i++) await weddingData.quickCreateTables(w, { count: 100, capacity: 8 });
      expect(await weddingData.listTables(w)).toHaveLength(300);
    });

    await test.step("The 301st table is refused, from Quick create and from the API, in plain words", async () => {
      const tables = new TablesTabPage(page);
      await tables.goto(w);
      await tables.quickCreateTables(1, 8);
      await expect(tables.message(TABLE_CAP_MESSAGE).first()).toBeVisible();
      const res = await context.request.post(`/api/v1/weddings/${w}/tables`, { data: { label: "One too many", capacity: 8 } });
      expect(res.status()).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe(TABLE_CAP_MESSAGE);
      expect(await weddingData.listTables(w)).toHaveLength(300);
    });

    await test.step("Past 50 plan versions the oldest go -- never the approved one", async () => {
      const first = await weddingData.generatePlanVersion(w);
      const approved = await weddingData.setPlanVersionStatus(w, first.id, "APPROVED");
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      for (let i = 2; i <= 51; i++) await weddingData.generatePlanVersion(w);
      const versions = await weddingData.listPlanVersions(w);
      expect(versions).toHaveLength(50);
      expect(versions.some((v) => v.id === first.id)).toBe(true);
    });

    await test.step("The 61st Generate in an hour is refused with a plain message", async () => {
      for (let i = 52; i <= 60; i++) await weddingData.generatePlanVersion(w);
      const res = await context.request.post(`/api/v1/weddings/${w}/plan-versions/generate`);
      expect(res.status()).toBe(429);
      expect(((await res.json()) as { error: string }).error).toBe(GENERATE_LIMIT_MESSAGE);
    });

    await test.step("TS-204: a body over the size limit is refused before it's read", async () => {
      const res = await context.request.post(`/api/v1/weddings/${w}/timeline-entries`, {
        headers: { "content-type": "application/json" },
        data: JSON.stringify({ time: "16:00", description: "x".repeat(5_000_000) }),
      });
      expect(res.status()).toBe(413);
    });
  },
);
