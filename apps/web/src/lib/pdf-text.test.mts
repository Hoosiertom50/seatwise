// TS-152: unit tests for what the PDF exports can draw. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPdfText } from "./pdf-text";
import { fontNames } from "./pdf-test-helpers";

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

// TS-158: with the embedded DejaVu Sans, names are drawn as written rather than simplified.
test("with a font that has the letters, names are kept exactly", () => {
  const has = new Set([..."ŁukaszWłęsNguyễnVăThắАнаПетров "].map((c) => c.codePointAt(0)!));
  const canDraw = (ch: string) => has.has(ch.codePointAt(0)!);
  assert.equal(toPdfText("Łukasz Wałęsa", canDraw), "Łukasz Wałęsa");
  assert.equal(toPdfText("Nguyễn Văn Thắng", canDraw), "Nguyễn Văn Thắng");
  assert.equal(toPdfText("Анна Петрова", canDraw), "Анна Петрова");
  // Still simplified or replaced when this font lacks the letter.
  assert.equal(toPdfText("Wąs 王", canDraw), "Was ?");
});

test("the exports embed the Unicode font, subset to the letters used", async () => {
  const { buildLookupListPdf } = await import("./pdf");
  const pdf = await buildLookupListPdf("Ană & Bogdán's Wedding", [
    { guestName: "Łukasz Wałęsa", tableLabel: "Stół 1" },
    { guestName: "Nguyễn Văn Thắng", tableLabel: "Bàn 2" },
    { guestName: "Анна Петрова", tableLabel: "Стол 3" },
    { guestName: "Ελένη Παπαδοπούλου", tableLabel: "Τραπέζι 4" },
  ]);
  const names = await fontNames(pdf);
  assert.ok(names.length > 0 && names.every((n) => n.includes("DejaVuSans")), names.join(", "));
  // Subsetting keeps the file small (the full fonts are ~1.4 MB).
  assert.ok(pdf.length < 150_000, `PDF is ${pdf.length} bytes`);
});

test("a long place-card name wraps onto two lines and/or shrinks to fit the card", async () => {
  const { readFile } = await import("node:fs/promises");
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  const { PDFDocument } = await import("pdf-lib");
  const { fitCardName } = await import("./pdf");
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bold = await doc.embedFont(await readFile("fonts/DejaVuSans-Bold.ttf"));
  const fits = (r: { lines: string[]; size: number }) =>
    r.lines.every((l) => bold.widthOfTextAtSize(l, r.size) <= 236);

  assert.deepEqual(fitCardName(bold, "Ana Ruiz", 236), { lines: ["Ana Ruiz"], size: 18 });
  const long = fitCardName(bold, "Maximilian Alexander Featherstonehaugh-Worthington", 236);
  assert.equal(long.lines.length, 2);
  assert.ok(fits(long) && long.size >= 10, JSON.stringify(long));
  const greek = fitCardName(bold, "Ελένη Παπαδοπούλου-Καραγιαννοπούλου", 236);
  assert.ok(fits(greek), JSON.stringify(greek));
});
