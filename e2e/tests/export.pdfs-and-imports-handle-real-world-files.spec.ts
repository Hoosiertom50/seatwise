/**
 * TS-152 (REQ-EXPORT-PRINT-RESTORE) — exports and imports cope with real guest lists.
 * - All three PDF exports succeed when guest names, table labels or the wedding name use letters
 *   outside the basic set (Łukasz, Nguyễn, 王) -- one such name used to make every export fail.
 * - A guest import skips a blank row in the middle of the file instead of failing it.
 * - An import is capped (5,000 guests, 2 MB), and the household name and notes limits match adding
 *   a guest by hand.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueTitle } from "../data/ids.js";

defineQualityTest(
  {
    id: "export.pdfs-and-imports-handle-real-world-files.unicode-pdfs-blank-rows-limits",
    title: "PDF exports work with names in any language, and guest imports skip blank rows and enforce sensible limits",
    objective:
      "Confirms that the seating chart, lookup list and place cards PDFs all return 200 application/pdf for an approved plan whose guests, table and wedding names include Polish, Vietnamese and Chinese characters; that an import with a blank row in the middle adds the other guests; that a 5,001-guest import, an over-2 MB file, a 201-character household name and a 2,001-character note are each refused with a clear reason.",
    expectedOutcome:
      "Three PDFs come back (200, application/pdf, non-trivial size). The import with a blank middle row creates 2 guests. The 5,001-row preview is refused with 'import at most 5,000'; the 2 MB+ file is refused; the long household name and note rows are reported as errors.",
    requirementIds: ["REQ-EXPORT-PRINT-RESTORE", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:export", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ weddingData, context }, testInfo) => {
    test.setTimeout(90_000);
    const api = (path: string) => `/api/v1/weddings/${path}`;

    await test.step("All three PDF exports work with names in other alphabets", async () => {
      const wedding = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Ana and Bogdan"));
      const w = wedding.id;
      await weddingData.createTable(w, { label: "Stół Główny", capacity: 10 });
      for (const [firstName, lastName] of [
        ["Łukasz", "Wałęsa"],
        ["Thắng", "Nguyễn"],
        ["伟", "王"],
      ]) {
        const res = await context.request.post(api(`${w}/guests`), { data: { firstName, lastName } });
        expect(res.status(), `${firstName} ${lastName}`).toBe(201);
      }
      const plan = await weddingData.generatePlanVersion(w);
      await weddingData.setPlanVersionStatus(w, plan.id, "IN_REVIEW");
      const fresh = (await (await context.request.get(api(`${w}/plan-versions/${plan.id}`))).json()) as {
        planVersion: { revision: number };
      };
      await weddingData.setPlanVersionStatus(w, plan.id, "APPROVED", fresh.planVersion.revision);
      for (const kind of ["chart", "lookup", "cards"]) {
        const res = await context.request.get(api(`${w}/plan-versions/${plan.id}/export/${kind}`));
        expect(res.status(), kind).toBe(200);
        expect(res.headers()["content-type"]).toContain("application/pdf");
        expect((await res.body()).length, kind).toBeGreaterThan(500);
      }
    });

    const w = (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Import Limits"))).id;
    const mapping = { firstName: "firstName", lastName: "lastName", partyName: "partyName", notes: "notes" };

    await test.step("A blank row in the middle of the file is skipped", async () => {
      const csv = "firstName,lastName,partyName,notes\nAda,Lovelace,,\n,,,\nAlan,Turing,,\n";
      const res = await context.request.post(api(`${w}/guests/import/commit`), { data: { csv, mapping } });
      expect(res.ok()).toBe(true);
      const { guests } = (await (await context.request.get(api(`${w}/guests`))).json()) as { guests: { lastName: string }[] };
      expect(guests.map((g) => g.lastName).sort()).toEqual(["Lovelace", "Turing"]);
    });

    await test.step("Too many guests, or too big a file, is refused with a clear reason", async () => {
      const many = "firstName,lastName\n" + Array.from({ length: 5001 }, (_, i) => `Guest,Number${"x".repeat(i % 3)}\n`).join("");
      const tooMany = await context.request.post(api(`${w}/guests/import/preview`), { data: { csv: many, mapping } });
      expect(tooMany.status()).toBe(422);
      expect(((await tooMany.json()) as { error: string }).error).toContain("import at most 5,000");

      const huge = "firstName,lastName,notes\n" + `Big,File,${"n".repeat(2_000_100)}\n`;
      const tooBig = await context.request.post(api(`${w}/guests/import/preview`), { data: { csv: huge, mapping } });
      expect(tooBig.status()).toBe(422);
    });

    await test.step("Household name and notes follow the same limits as adding a guest by hand", async () => {
      const csv = `firstName,lastName,partyName,notes\nLong,Household,${"h".repeat(201)},\nLong,Notes,,${"n".repeat(2001)}\n`;
      const res = await context.request.post(api(`${w}/guests/import/preview`), { data: { csv, mapping } });
      expect(res.ok()).toBe(true);
      const { preview } = (await res.json()) as { preview: { rows: { kind: string; reason?: string }[] } };
      expect(preview.rows.map((r) => r.kind)).toEqual(["error", "error"]);
      expect(preview.rows[0].reason).toContain("Household name can be at most 200");
      expect(preview.rows[1].reason).toContain("Notes can be at most 2000");
    });
  },
);
