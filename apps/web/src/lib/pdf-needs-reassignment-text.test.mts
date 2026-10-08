// TS-250: what the three PDFs actually print for a guest whose seat needs changing since approval.
// A file of its own because it reads the text back from the PDFs, which needs the built-in Helvetica
// (plain letter codes) rather than the shipped fonts -- and the font folder is fixed when pdf.ts is
// first loaded (see pdf-font-fallback.test.mts). Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExportGuestRow, PdfExtras } from "./pdf";

process.chdir(mkdtempSync(path.join(tmpdir(), "seatwise-pdf-text-")));
const quietError = console.error;
console.error = () => {}; // the expected "couldn't load the DejaVu fonts" line

/** Every line of text drawn on each page, in drawing order. */
async function pageTexts(pdf: Uint8Array): Promise<string[][]> {
  const { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
    const lines: string[] = [];
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const ops = Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
      for (const m of ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) lines.push(Buffer.from(m[1], "hex").toString("latin1"));
    }
    return lines;
  });
}

const flaggedRow = { guestName: "Bo Flag", tableLabel: "Table 3", plusOneNames: "Kim", needsReassignment: true };
const seatedRow = { guestName: "Ann Lee", tableLabel: "Table 3", plusOneNames: null };

test.after(() => {
  console.error = quietError;
});

test("seating chart: a flagged guest is under 'Needs reassignment' with the table they were at, not at the table", async () => {
  const { buildSeatingChartPdf } = await import("./pdf");
  const texts = (await pageTexts(
    await buildSeatingChartPdf("W", [{ label: "Table 3", guestNames: ["Ann Lee"] }], { needsReassignment: [flaggedRow] })
  )).flat();
  const heading = texts.indexOf("Needs reassignment (1)");
  assert.ok(heading > 0, texts.join(" | "));
  const flaggedAt = texts.findIndex((t) => t.includes("Bo Flag"));
  assert.ok(flaggedAt > heading, "listed after the heading");
  assert.ok(texts[flaggedAt].includes("+ Kim"));
  assert.ok(texts.includes("(was at Table 3)"), texts.join(" | "));
  assert.equal(texts.filter((t) => t.includes("Bo Flag")).length, 1, "printed once, not also at the table");
});

test("lookup list: a flagged guest isn't listed with a table, only under 'Needs reassignment'", async () => {
  const { buildLookupListPdf } = await import("./pdf");
  // Passed both ways -- in the rows with the flag, and as extras -- it's never printed at the table.
  const cases: [ExportGuestRow[], PdfExtras][] = [
    [[seatedRow, flaggedRow], {}],
    [[seatedRow], { needsReassignment: [flaggedRow] }],
  ];
  for (const [rows, extras] of cases) {
    const texts = (await pageTexts(await buildLookupListPdf("W", rows, extras))).flat();
    const heading = texts.indexOf("Needs reassignment (1)");
    assert.ok(heading > 0, texts.join(" | "));
    const named = texts.map((t, i) => [t, i] as const).filter(([t]) => t.includes("Bo Flag"));
    assert.equal(named.length, 1, texts.join(" | "));
    assert.ok(named[0][1] > heading);
    // Only Ann's row prints "Table 3" bare; Bo's says "(was at Table 3)".
    assert.equal(texts.filter((t) => t === "Table 3").length, 1);
    assert.ok(texts.includes("(was at Table 3)"));
  }
});

test("place cards: no card for a flagged guest -- they're listed on the last page instead", async () => {
  const { buildPlaceCardsPdf } = await import("./pdf");
  const pages = await pageTexts(await buildPlaceCardsPdf([seatedRow, flaggedRow], { unseated: [{ guestName: "Cy New" }] }));
  assert.equal(pages.length, 2, "one page of cards, one list page");
  assert.ok(pages[0].includes("Ann Lee"));
  assert.ok(!pages[0].some((t) => t.includes("Bo Flag")), "no card for Bo");
  const last = pages[1];
  assert.ok(last.includes("Needs reassignment (1)"), last.join(" | "));
  assert.ok(last.some((t) => t.includes("Bo Flag")));
  assert.ok(last.includes("(was at Table 3)"));
  assert.ok(last.includes("Not seated (1)"));
  // Only flagged guests: still a list page, and no blank card page.
  const onlyFlagged = await pageTexts(await buildPlaceCardsPdf([flaggedRow]));
  assert.equal(onlyFlagged.length, 1);
  assert.ok(onlyFlagged[0].includes("Needs reassignment (1)"));
});
