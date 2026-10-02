// TS-152: unit tests for what the PDF exports can draw. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPdfText } from "./pdf-text";

test("names the built-in font can draw are kept exactly", () => {
  for (const name of ["José Álvarez", "Zoë Müller", "Ñuñez", "Søren Ørsted", "Strauß", "O'Brien-Smith", "Table 12 — Head"]) {
    assert.equal(toPdfText(name), name);
  }
});

test("accented letters the font lacks become their plain letter", () => {
  assert.equal(toPdfText("Nguyễn Văn Thắng"), "Nguyen Van Thang");
  assert.equal(toPdfText("Łukasz Wałęsa"), "Lukasz Walesa");
  assert.equal(toPdfText("Đặng"), "Dang");
  assert.equal(toPdfText("Ştefan Ţurcanu"), "Stefan Turcanu");
});

test("decomposed accents are kept where the font has the letter", () => {
  assert.equal(toPdfText("José"), "José");
});

test("other scripts and emoji become '?' rather than breaking the export", () => {
  assert.equal(toPdfText("王伟"), "??");
  assert.equal(toPdfText("Ana 💐"), "Ana ?");
  assert.equal(toPdfText("Line\tbreak\n"), "Line break ");
});

test("all three exports build with names in any script", async () => {
  const { buildSeatingChartPdf, buildLookupListPdf, buildPlaceCardsPdf } = await import("./pdf");
  const rows = [
    { guestName: "Łukasz Wałęsa", tableLabel: "Stół 1" },
    { guestName: "Nguyễn Văn Thắng", tableLabel: "Bàn 2" },
    { guestName: "王伟", tableLabel: "桌 3" },
    { guestName: "Zoë 💐", tableLabel: "Head Table" },
  ];
  const chart = await buildSeatingChartPdf("Ană & Bogdán's Wedding", [{ label: "Stół 1", guestNames: rows.map((r) => r.guestName) }]);
  const lookup = await buildLookupListPdf("Ană & Bogdán's Wedding", rows);
  const cards = await buildPlaceCardsPdf(rows);
  for (const pdf of [chart, lookup, cards]) assert.ok(pdf.length > 500);
});
