/**
 * TS-233 — guest import fixes from the ninth review.
 * - A file over 2 MB says why it was refused ("too big"), not just "Validation failed".
 * - An ordinary Windows "CSV (Comma delimited)" file with a curly apostrophe in Household, a "‹VIP›"
 *   note and French quotes ("« Pas de café »") is imported, not refused as the older Mac format or
 *   as mixed text formats.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";

/** The windows-1252 bytes for this text (the few non-ASCII characters these tests use). */
function windows1252(text: string): Buffer {
  const table: Record<string, number> = { "’": 0x92, "‹": 0x8b, "›": 0x9b, "†": 0x86, "«": 0xab, "»": 0xbb, " ": 0xa0, "é": 0xe9 };
  return Buffer.from([...text].map((ch) => table[ch] ?? ch.charCodeAt(0)));
}

defineQualityTest(
  {
    id: "cross-cutting.review-9-guest-import-files-are-read-fairly.big-file-says-too-big",
    title: "an import file over 2 MB is refused with the plain \"too big\" message",
    objective:
      "Uploads on the Guests tab a CSV of about 2.3 MB (first name, last name and a long notes column, all mapped) and asks for a preview. Confirms the error line says the file is too big and to keep it under 2 MB, and doesn't say 'Validation failed'. Nothing is imported.",
    expectedOutcome:
      "The import error reads 'That file is too big — keep it under 2 MB.'; no 'Validation failed' text appears; no preview is shown and the guest list has no guests with the file's last name.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, context, page }, testInfo) => {
    const w = managedWedding.id;
    const suffix = uniqueToken(testInfo.workerIndex);
    const guests = new WeddingGuestsPage(page);
    const note = "x".repeat(1000);
    let file = "firstName,lastName,notes\r\n";
    for (let i = 0; i < 2300; i++) file += `Ana,Big-${suffix},${note}\r\n`;

    await test.step("Choose the 2.3 MB file and ask for a preview", async () => {
      await guests.goto(w);
      await guests.chooseImportFile(file, "big.csv");
      await guests.previewImportButtonLocator().click();
    });

    await test.step("The error says the file is too big, not 'Validation failed'", async () => {
      await expect(guests.importError("That file is too big — keep it under 2 MB.")).toBeVisible();
      await expect(guests.importError("Validation failed")).toHaveCount(0);
      await expect(guests.importPreviewSummary()).toHaveCount(0);
      const saved = ((await (await context.request.get(`/api/v1/weddings/${w}/guests`)).json()) as {
        guests: { lastName: string }[];
      }).guests;
      expect(saved.filter((g) => g.lastName === `Big-${suffix}`)).toHaveLength(0);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-9-guest-import-files-are-read-fairly.windows-file-with-apostrophes-and-quotes",
    title: "an ordinary Windows CSV with a possessive household, a ‹VIP› note and French quotes is imported",
    objective:
      "Uploads on the Guests tab a windows-1252 file (Excel's 'CSV (Comma delimited)') with columns firstName, lastName, partyName, plusOneNames and notes: household 'Bride’s college friends', plus-ones 'Sarah’s husband Tom', and notes '‹VIP›', 'In memory of †Opa' and '« Pas de café »'. Previews and imports it.",
    expectedOutcome:
      "No 'older Mac format' or 'different text format' refusal; the preview shows 3 new and 0 with errors; after importing, the guests have the household, plus-ones and notes exactly as written (curly apostrophe, ‹ › † « » and the no-break spaces kept).",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, context, page }, testInfo) => {
    const w = managedWedding.id;
    const suffix = uniqueToken(testInfo.workerIndex);
    const guests = new WeddingGuestsPage(page);
    // French spacing: no-break spaces inside the quotes (bytes E9 A0 BB after "caf").
    const french = "« Pas de café »";
    const text =
      "firstName,lastName,headcount,partyName,plusOneNames,notes\r\n" +
      `Ana,Win-${suffix},2,Bride’s college friends,Sarah’s husband Tom,‹VIP›\r\n` +
      `Bo,Win-${suffix},1,,,In memory of †Opa\r\n` +
      `Cy,Win-${suffix},1,,,${french}\r\n`;

    await test.step("Preview the Windows file: nothing refused", async () => {
      await guests.goto(w);
      await guests.importGuestsFileBytesAndPreview(windows1252(text));
      await expect(guests.importPreviewSummary()).toContainText("3 new");
      await expect(guests.importPreviewErrorCountText()).toContainText("0 with errors");
      await expect(guests.importError(/older Mac format|different text format/)).toHaveCount(0);
    });

    await test.step("Import: every value saved exactly as written", async () => {
      await guests.confirmImport();
      const saved = ((await (await context.request.get(`/api/v1/weddings/${w}/guests`)).json()) as {
        guests: { firstName: string; lastName: string; partyName: string | null; plusOneNames: string | null; notes: string | null }[];
      }).guests.filter((g) => g.lastName === `Win-${suffix}`);
      const by = (first: string) => saved.find((g) => g.firstName === first)!;
      expect(by("Ana").partyName).toBe("Bride’s college friends");
      expect(by("Ana").plusOneNames).toBe("Sarah’s husband Tom");
      expect(by("Ana").notes).toBe("‹VIP›");
      expect(by("Bo").notes).toBe("In memory of †Opa");
      expect(by("Cy").notes).toBe(french);
    });
  },
);
