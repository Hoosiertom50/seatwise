// TS-205: the place cards and lookup list measure each name a handful of times, not once per split
// point and size -- 200 place cards for worst-case names (100 one-letter words) used to take about
// 25 seconds. These check the faster fitting picks exactly what the old, measure-everything way
// picked, and that the worst case now finishes well inside 2 seconds. Run with
// `pnpm --filter @seatwise/web test` (from apps/web, where the fonts are).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { fitCardName, fitText, buildPlaceCardsPdf } from "./pdf";

// The fitting as it was before TS-205 (every candidate measured in full), to compare against.
function oldFitText(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (font.widthOfTextAtSize(chars.slice(0, mid).join("").trimEnd() + "…", size) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join("").trimEnd() + "…";
}
function oldFitCardName(font: PDFFont, name: string, maxWidth: number) {
  const widest = (lines: string[], size: number) => Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)));
  const options: string[][] = [[name]];
  const words = name.split(" ");
  if (words.length > 1) {
    let best: string[] | null = null;
    for (let i = 1; i < words.length; i++) {
      const pair = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
      if (!best || widest(pair, 18) < widest(best, 18)) best = pair;
    }
    options.push(best!);
  }
  for (let size = 18; size >= 8; size--) {
    for (const lines of options) if (widest(lines, size) <= maxWidth) return { lines, size };
  }
  return { lines: options[options.length - 1], size: 8 };
}

const NAMES = [
  "Ana Ruiz",
  "Maximilian Alexander Featherstonehaugh-Worthington",
  "Ελένη Παπαδοπούλου-Καραγιαννοπούλου",
  "W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W W",
  "Mary  Jo   Double Spaces",
  "O'Brien-Smythe de la Cruz y Montenegro",
  "W".repeat(100),
  "fi fl ffi office waffle Kafka",
  "Li",
];

// Helvetica (the fallback) only draws Western letters -- the app passes it nothing else (pdf-text.ts).
const drawable = (font: PDFFont, text: string) => !font.name.includes("Helvetica") || /^[\x20-\x7e]*$/.test(text);

async function fonts(): Promise<PDFFont[]> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  return [
    await doc.embedFont(await readFile("fonts/DejaVuSans-Bold.ttf"), { subset: true }),
    await doc.embedFont(await readFile("fonts/DejaVuSans.ttf"), { subset: true }),
    await doc.embedFont(StandardFonts.Helvetica),
  ];
}

test("place-card names are fitted exactly as before", async () => {
  for (const font of await fonts()) {
    for (const name of NAMES.filter((n) => drawable(font, n))) {
      for (const width of [60, 120, 236, 400]) {
        assert.deepEqual(fitCardName(font, name, width), oldFitCardName(font, name, width), `${name} @ ${width}`);
      }
    }
  }
});

test("long text is cut short exactly as before", async () => {
  for (const font of await fonts()) {
    for (const text of [...NAMES, "Table for the bride's oldest and dearest friends from university", "T".repeat(100)].filter((t) => drawable(font, t))) {
      for (const [size, width] of [[11, 200], [11, 80], [13, 504], [8, 236], [18, 30]] as const) {
        assert.equal(fitText(font, text, size, width), oldFitText(font, text, size, width), `${text} @ ${size}/${width}`);
      }
    }
  }
});

test("200 place cards for worst-case names finish in under 2 seconds", async () => {
  const wordy = Array.from({ length: 50 }, () => "W").join(" ");
  const rows = Array.from({ length: 200 }, (_, i) => ({ guestName: `${wordy} ${wordy}`, tableLabel: `Table ${i % 30}` }));
  await buildPlaceCardsPdf([{ guestName: "Warm Up", tableLabel: "1" }]); // fonts read once
  const start = performance.now();
  await buildPlaceCardsPdf(rows);
  const ms = performance.now() - start;
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
});
