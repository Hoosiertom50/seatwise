import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";
import { inWinAnsi, toPdfText } from "./pdf-text";

// TS-12 (Export & Print, FR-9.1/9.2/9.3): three PDF exports built from the same
// (guestName, tableLabel) data every plan-version endpoint already returns. No layout/rendering
// library beyond pdf-lib — everything here is drawn by hand at the point level (72pt = 1in),
// which keeps the whole thing dependency-light and fully server-side (no headless browser).

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54; // 0.75in

export interface ExportGuestRow {
  guestName: string;
  tableLabel: string;
  // TS-180: who's coming with them -- shown on the lookup list.
  plusOneNames?: string | null;
}

/**
 * TS-180: `text` cut short with an ellipsis so it fits `maxWidth` at `size` -- long names and table
 * names used to run off the page, into the table column, or over a place card's cut line.
 */
export function fitText(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ellipsis = "…";
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  // The longest start of the text that fits with the ellipsis after it.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (font.widthOfTextAtSize(chars.slice(0, mid).join("").trimEnd() + ellipsis, size) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join("").trimEnd() + ellipsis;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  /** Only text these fonts can draw (see pdf-text.ts). */
  text: (s: string) => string;
}

// TS-158: DejaVu Sans, shipped with the app (fonts/, included in the export routes' bundles by
// next.config.ts). Read once per server instance.
const FONT_DIR = path.join(process.cwd(), "fonts");
let fontFiles: Promise<{ regular: Uint8Array; bold: Uint8Array }> | null = null;
function loadFontFiles() {
  fontFiles ??= Promise.all([
    readFile(path.join(FONT_DIR, "DejaVuSans.ttf")),
    readFile(path.join(FONT_DIR, "DejaVuSans-Bold.ttf")),
  ]).then(([regular, bold]) => ({ regular, bold }));
  fontFiles.catch(() => (fontFiles = null)); // try again next time rather than caching a failure
  return fontFiles;
}

// pdf-lib draws characters one after another, left to right, with no joining -- right-to-left
// scripts would come out backwards (and Arabic unjoined), so they're left to the "?" fallback.
const RIGHT_TO_LEFT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

async function newDoc(): Promise<{ doc: PDFDocument; fonts: Fonts }> {
  const doc = await PDFDocument.create();
  try {
    const files = await loadFontFiles();
    doc.registerFontkit(fontkit);
    // subset: only the letters actually used go into the file, so a PDF stays small.
    const regular = await doc.embedFont(files.regular, { subset: true });
    const bold = await doc.embedFont(files.bold, { subset: true });
    const inBold = new Set(bold.getCharacterSet());
    const drawable = new Set(regular.getCharacterSet().filter((c) => inBold.has(c)));
    const canDraw = (ch: string) => {
      const c = ch.codePointAt(0)!;
      return c >= 0x20 && drawable.has(c) && !RIGHT_TO_LEFT.test(ch);
    };
    return { doc, fonts: { regular, bold, text: (s) => toPdfText(s, canDraw) } };
  } catch (err) {
    // The export must never fail over a font: fall back to the built-in Helvetica (TS-152).
    console.error("PDF export: couldn't load the DejaVu fonts, using Helvetica", err);
    return {
      doc,
      fonts: {
        regular: await doc.embedFont(StandardFonts.Helvetica),
        bold: await doc.embedFont(StandardFonts.HelveticaBold),
        text: (s) => toPdfText(s, inWinAnsi),
      },
    };
  }
}

function safeRow(fonts: Fonts, row: ExportGuestRow): ExportGuestRow {
  return {
    guestName: fonts.text(row.guestName),
    tableLabel: fonts.text(row.tableLabel),
    plusOneNames: row.plusOneNames ? fonts.text(row.plusOneNames) : null,
  };
}

/** TS-211: what every export PDF also prints -- when it was made, and who isn't seated. */
export interface PdfExtras {
  /** e.g. "Generated 10-07-2026 3:45 PM EDT" (see formatGeneratedAt in export-data.ts). */
  generatedAt?: string;
  /** Attending guests with no seat in the plan. */
  unseated?: { guestName: string; plusOneNames?: string | null }[];
}

// TS-211: the generated date and time, small and grey at the top right of a page.
function drawGeneratedAt(page: PDFPage, fonts: Fonts, generatedAt: string | undefined, y = PAGE_HEIGHT - MARGIN): number {
  if (!generatedAt) return 0;
  const text = fonts.text(generatedAt);
  const width = fonts.regular.widthOfTextAtSize(text, 9);
  page.drawText(text, { x: PAGE_WIDTH - MARGIN - width, y, size: 9, font: fonts.regular, color: rgb(0.4, 0.4, 0.4) });
  return width + 12;
}

export const NOT_SEATED_HEADING = "Not seated";
const NOT_SEATED_NOTE = "Coming, but not at a table in this plan yet:";

/**
 * TS-211: the "Not seated" section -- every attending guest with no seat, so the door list and chart
 * never leave out someone who is coming. Starts a new page when there's no room for the heading.
 * Returns the page and height it ended on.
 */
function drawNotSeated(
  doc: PDFDocument,
  page: PDFPage,
  y: number,
  fonts: Fonts,
  unseated: PdfExtras["unseated"]
): { page: PDFPage; y: number } {
  if (!unseated || unseated.length === 0) return { page, y };
  const lineHeight = 16;
  if (y < MARGIN + 60) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y -= 6;
  page.drawText(`${NOT_SEATED_HEADING} (${unseated.length})`, { x: MARGIN, y, size: 13, font: fonts.bold, color: rgb(0.6, 0.1, 0.1) });
  y -= 18;
  page.drawText(NOT_SEATED_NOTE, { x: MARGIN, y, size: 10, font: fonts.regular, color: rgb(0.4, 0.4, 0.4) });
  y -= lineHeight;
  for (const g of unseated) {
    if (y < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    const name = fonts.text(g.guestName);
    const text = g.plusOneNames ? `•  ${name}  + ${fonts.text(g.plusOneNames)}` : `•  ${name}`;
    page.drawText(fitText(fonts.regular, text, 11, PAGE_WIDTH - MARGIN * 2 - 14), { x: MARGIN + 14, y, size: 11, font: fonts.regular });
    y -= lineHeight;
  }
  return { page, y };
}

function drawHeader(page: PDFPage, fonts: Fonts, title: string, weddingName: string, generatedAt?: string) {
  // TS-211: the generated date and time on the same line, at the right.
  const stampWidth = drawGeneratedAt(page, fonts, generatedAt);
  // TS-180: a long wedding name is cut short rather than running off the page.
  page.drawText(fitText(fonts.regular, weddingName, 11, PAGE_WIDTH - MARGIN * 2 - stampWidth), {
    x: MARGIN,
    y: PAGE_HEIGHT - MARGIN,
    size: 11,
    font: fonts.regular,
    color: rgb(0.4, 0.4, 0.4),
  });
  page.drawText(title, {
    x: MARGIN,
    y: PAGE_HEIGHT - MARGIN - 20,
    size: 18,
    font: fonts.bold,
  });
}

// FR-9.1: the full chart, table by table, guest names under each.
export async function buildSeatingChartPdf(
  weddingName: string,
  tables: { label: string; guestNames: string[] }[],
  extras: PdfExtras = {}
): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  // TS-152: only text the PDF font can draw (see pdf-text.ts).
  weddingName = fonts.text(weddingName);
  tables = tables.map((t) => ({ label: fonts.text(t.label), guestNames: t.guestNames.map(fonts.text) }));
  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawHeader(page, fonts, "Seating Chart", weddingName, extras.generatedAt);
  let y = PAGE_HEIGHT - MARGIN - 56;
  const lineHeight = 16;
  const tableHeaderGap = 22;

  for (const table of tables) {
    // Keep a table's header with at least its first guest — start a fresh page rather than an
    // orphaned heading at the very bottom.
    if (y < MARGIN + tableHeaderGap + lineHeight) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    page.drawText(fitText(fonts.bold, table.label, 13, PAGE_WIDTH - MARGIN * 2), { x: MARGIN, y, size: 13, font: fonts.bold });
    y -= tableHeaderGap;

    if (table.guestNames.length === 0) {
      page.drawText("(no one seated here)", {
        x: MARGIN + 14,
        y,
        size: 10,
        font: fonts.regular,
        color: rgb(0.5, 0.5, 0.5),
      });
      y -= lineHeight;
    }
    for (const name of table.guestNames) {
      if (y < MARGIN) {
        page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
      page.drawText(fitText(fonts.regular, `•  ${name}`, 11, PAGE_WIDTH - MARGIN * 2 - 14), {
        x: MARGIN + 14,
        y,
        size: 11,
        font: fonts.regular,
      });
      y -= lineHeight;
    }
    y -= 10;
  }
  // TS-211
  drawNotSeated(doc, page, y, fonts, extras.unseated);

  return doc.save();
}

// FR-9.2: every guest, alphabetically, with their table — a fast lookup for whoever's on
// door/registration duty.
export async function buildLookupListPdf(
  weddingName: string,
  rows: ExportGuestRow[],
  extras: PdfExtras = {}
): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  weddingName = fonts.text(weddingName);
  rows = rows.map((r) => safeRow(fonts, r));
  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawHeader(page, fonts, "Guest Lookup List", weddingName, extras.generatedAt);
  let y = PAGE_HEIGHT - MARGIN - 56;
  const lineHeight = 18;

  for (const row of rows) {
    if (y < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    // TS-180: the table name gets up to 40% of the line and the guest's name (with who's coming
    // with them) the rest, each cut short with "…" if it's longer -- they used to overlap.
    const lineWidth = PAGE_WIDTH - MARGIN * 2;
    const tableText = fitText(fonts.bold, row.tableLabel, 11, lineWidth * 0.4);
    const tableWidth = fonts.bold.widthOfTextAtSize(tableText, 11);
    const nameText = row.plusOneNames ? `${row.guestName}  + ${row.plusOneNames}` : row.guestName;
    page.drawText(fitText(fonts.regular, nameText, 11, lineWidth - tableWidth - 16), {
      x: MARGIN,
      y,
      size: 11,
      font: fonts.regular,
    });
    page.drawText(tableText, {
      x: PAGE_WIDTH - MARGIN - tableWidth,
      y,
      size: 11,
      font: fonts.bold,
    });
    y -= lineHeight;
  }
  // TS-211: so whoever is on the door finds a guest who is coming but has no table yet.
  drawNotSeated(doc, page, y - 8, fonts, extras.unseated);

  return doc.save();
}

/**
 * TS-158: the largest size (18pt down to 8pt) at which a place-card name fits `maxWidth` -- on one
 * line if it can, otherwise split at the space that best balances two lines. A name with no space
 * that still doesn't fit at 8pt is drawn at 8pt.
 */
export function fitCardName(font: PDFFont, name: string, maxWidth: number): { lines: string[]; size: number } {
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

// FR-9.3: one print-ready place/escort card per guest — name and table, cut lines, several to a
// page. Sized generously (roughly 3.6in x 2.3in) for readability over cramming the max per page.
export async function buildPlaceCardsPdf(rows: ExportGuestRow[], extras: PdfExtras = {}): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  rows = rows.map((r) => safeRow(fonts, r));
  const cols = 2;
  const rowsPerPage = 4;
  const cardW = (PAGE_WIDTH - MARGIN * 2) / cols;
  const cardH = (PAGE_HEIGHT - MARGIN * 2) / rowsPerPage;

  let page: PDFPage | null = null;
  let indexOnPage = 0;

  for (const row of rows) {
    if (indexOnPage % (cols * rowsPerPage) === 0) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      indexOnPage = 0;
    }
    const col = indexOnPage % cols;
    const rowIdx = Math.floor(indexOnPage / cols);
    const x = MARGIN + col * cardW;
    const yTop = PAGE_HEIGHT - MARGIN - rowIdx * cardH;

    page!.drawRectangle({
      x,
      y: yTop - cardH,
      width: cardW,
      height: cardH,
      borderColor: rgb(0.75, 0.75, 0.75),
      borderWidth: 0.75,
    });

    // TS-158: a long name goes onto two lines and/or shrinks, rather than running over the cut line.
    const { lines, size: nameSize } = fitCardName(fonts.bold, row.guestName, cardW - 16);
    const lineGap = nameSize * 1.2;
    lines.forEach((fullLine, i) => {
      // TS-180: still too wide at the smallest size (one very long word) -- cut short with "…".
      const line = fitText(fonts.bold, fullLine, nameSize, cardW - 16);
      const lineWidth = fonts.bold.widthOfTextAtSize(line, nameSize);
      page!.drawText(line, {
        x: x + (cardW - lineWidth) / 2,
        y: yTop - cardH / 2 - nameSize / 2 + 10 + (lines.length - 1 - i) * lineGap,
        size: nameSize,
        font: fonts.bold,
      });
    });

    const tableSize = 12;
    // TS-180: a long table name is cut short rather than running over the cut line.
    const tableText = fitText(fonts.regular, row.tableLabel, tableSize, cardW - 16);
    const tableWidth = fonts.regular.widthOfTextAtSize(tableText, tableSize);
    page!.drawText(tableText, {
      x: x + (cardW - tableWidth) / 2,
      y: yTop - cardH / 2 - 14,
      size: tableSize,
      font: fonts.regular,
      color: rgb(0.35, 0.35, 0.35),
    });

    indexOnPage++;
  }

  if (rows.length === 0 && !extras.unseated?.length) {
    doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  }
  // TS-211: guests with no seat get no card -- listed on a last page instead, so nobody is missed.
  if (extras.unseated?.length) {
    const last = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    last.drawText(fonts.text("Place cards — guests without a card"), { x: MARGIN, y: PAGE_HEIGHT - MARGIN - 20, size: 18, font: fonts.bold });
    drawNotSeated(doc, last, PAGE_HEIGHT - MARGIN - 44, fonts, extras.unseated);
  }
  // TS-211: the generated date and time on every page (cards have no header to carry it).
  // Just above the first row of cards.
  for (const p of doc.getPages()) drawGeneratedAt(p, fonts, extras.generatedAt, PAGE_HEIGHT - MARGIN + 8);

  return doc.save();
}
