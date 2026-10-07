// TS-205: times the PDF exports with worst-case names -- 200 place cards for guests whose first
// and last names are each 100 characters of single letters and spaces ("W W W ..."), the case that
// took 24.8 s before, and a lookup list of 1,000 guests with 100-character names. Run from
// apps/web: `npx tsx scripts/pdf-timing.mts`. Prints the times; nothing is written.
import { buildLookupListPdf, buildPlaceCardsPdf, buildSeatingChartPdf } from "../src/lib/pdf";

const wordy = (letter: string) => Array.from({ length: 50 }, () => letter).join(" "); // 99 characters
const worstName = `${wordy("W")} ${wordy("W")}`;
const longWord = "W".repeat(100);

async function time(label: string, run: () => Promise<Uint8Array>) {
  const start = performance.now();
  const pdf = await run();
  const ms = performance.now() - start;
  console.log(`${label}: ${(ms / 1000).toFixed(2)} s (${(pdf.length / 1024).toFixed(0)} KB)`);
  return ms;
}

const placeCardRows = Array.from({ length: 200 }, (_, i) => ({ guestName: worstName, tableLabel: `Table ${i % 30}` }));
const longWordRows = Array.from({ length: 200 }, (_, i) => ({ guestName: `${longWord} ${longWord}`, tableLabel: "T".repeat(100) + i }));
const lookupRows = Array.from({ length: 1000 }, (_, i) => ({
  guestName: `${"Abcdefghij".repeat(10)} ${"Klmnopqrst".repeat(10)}`,
  tableLabel: "T".repeat(100),
  plusOneNames: i % 2 ? "Someone With A Fairly Long Name, Another Guest" : null,
}));

// Warm up (font loading) so the first measurement isn't mostly reading the font files.
await buildPlaceCardsPdf([{ guestName: "Warm Up", tableLabel: "1" }]);

const cards = await time("200 place cards, names of 100 one-letter words", () => buildPlaceCardsPdf(placeCardRows));
await time("200 place cards, two 100-letter words", () => buildPlaceCardsPdf(longWordRows));
await time("lookup list, 1,000 guests with 100-character names", () => buildLookupListPdf("A wedding", lookupRows));
await time("seating chart, 1,000 guests at 30 tables", () =>
  buildSeatingChartPdf(
    "A wedding",
    Array.from({ length: 30 }, (_, t) => ({
      label: `Table ${t}`,
      guestNames: lookupRows.filter((_, i) => i % 30 === t).map((r) => r.guestName),
    }))
  )
);
if (cards > 2000) {
  console.error("Place cards took longer than 2 s.");
  process.exitCode = 1;
}
