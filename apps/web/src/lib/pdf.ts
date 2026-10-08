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
  // TS-250: flagged "Needs reassignment" after approval -- tableLabel is the table they're at now,
  // which no longer works for them. Never printed at that table (see splitFlagged).
  needsReassignment?: boolean;
}

// TS-205: text widths at size 1, measured once per font and piece of text. Measuring lays the
// whole text out again each time, and the place cards and lookup list used to measure the same name
// dozens of times over (every split point, every size, every step of a search) -- 200 place cards
// for names made of many short words took about 25 seconds. A width grows in step with the size,
// so one measurement at size 1 serves every size. Kept per font, so it goes away with its PDF.
const unitWidths = new WeakMap<PDFFont, Map<string, number>>();
function unitWidth(font: PDFFont, text: string): number {
  let cache = unitWidths.get(font);
  if (!cache) unitWidths.set(font, (cache = new Map()));
  let width = cache.get(text);
  if (width === undefined) {
    width = font.widthOfTextAtSize(text, 1);
    cache.set(text, width);
  }
  return width;
}
const widthAt = (font: PDFFont, text: string, size: number) => unitWidth(font, text) * size;

/**
 * TS-180: `text` cut short with an ellipsis so it fits `maxWidth` at `size` -- long names and table
 * names used to run off the page, into the table column, or over a place card's cut line.
 * TS-205: the cut is found from each character's width (measured once) added up, then checked
 * against the real width of the result -- a handful of measurements instead of a full one per step
 * of a search.
 */
export function fitText(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (widthAt(font, text, size) <= maxWidth) return text;
  const ellipsis = "…";
  const chars = [...text];
  const cut = (n: number) => chars.slice(0, n).join("").trimEnd() + ellipsis;
  const fits = (n: number) => widthAt(font, cut(n), size) <= maxWidth;
  // Estimate: the most characters whose widths, plus the ellipsis, add up to no more than maxWidth.
  let room = maxWidth / size - unitWidth(font, ellipsis);
  let n = 0;
  while (n < chars.length && room - unitWidth(font, chars[n]) >= 0) {
    room -= unitWidth(font, chars[n]);
    n++;
  }
  // Then settle it on the real width (letters drawn together can differ slightly from the sum).
  while (n > 0 && !fits(n)) n--;
  while (n < chars.length && fits(n + 1)) n++;
  return cut(n);
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
    needsReassignment: row.needsReassignment,
  };
}

/** TS-211: what every export PDF also prints -- when it was made, and who isn't seated. */
export interface PdfExtras {
  /** e.g. "Generated 10-07-2026 3:45 PM EDT" (see formatGeneratedAt in export-data.ts). */
  generatedAt?: string;
  /** Attending guests with no seat in the plan. */
  unseated?: { guestName: string; plusOneNames?: string | null }[];
  /** TS-250: guests whose seat needs changing, with the table they're at now. */
  needsReassignment?: ExportGuestRow[];
}

/**
 * TS-250: the rows that go at a table, and the guests listed under "Needs reassignment" instead --
 * those passed in `extras` plus any row that carries the flag, so a flagged guest is never printed
 * at the table that no longer works for them.
 */
export function splitFlagged(rows: ExportGuestRow[], extras: PdfExtras): { rows: ExportGuestRow[]; flagged: ExportGuestRow[] } {
  return {
    rows: rows.filter((r) => !r.needsReassignment),
    flagged: [...(extras.needsReassignment ?? []), ...rows.filter((r) => r.needsReassignment)],
  };
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
// TS-250: the section for guests whose seat needs changing since the plan was approved.
export const NEEDS_REASSIGNMENT_HEADING = "Needs reassignment";
const NEEDS_REASSIGNMENT_NOTE = "Their table no longer works for them (it changed after approval) -- find them a new seat:";

/** TS-250: "(was at Table 3)" -- the table a flagged guest is at now, printed after their name. */
export function wasAtText(tableLabel: string): string {
  return `(was at ${tableLabel})`;
}

/**
 * TS-211: a section listing guests by name under a red heading with a count (TS-250: shared by "Not
 * seated" and "Needs reassignment", which also says the table each guest was at). Starts a new page
 * when there's no room for the heading. Returns the page and height it ended on.
 */
function drawGuestSection(
  doc: PDFDocument,
  page: PDFPage,
  y: number,
  fonts: Fonts,
  heading: string,
  note: string,
  guests: { guestName: string; plusOneNames?: string | null; tableLabel?: string }[]
): { page: PDFPage; y: number } {
  if (guests.length === 0) return { page, y };
  const lineHeight = 16;
  const lineWidth = PAGE_WIDTH - MARGIN * 2 - 14;
  if (y < MARGIN + 60) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y -= 6;
  page.drawText(`${heading} (${guests.length})`, { x: MARGIN, y, size: 13, font: fonts.bold, color: rgb(0.6, 0.1, 0.1) });
  y -= 18;
  page.drawText(fitText(fonts.regular, note, 10, PAGE_WIDTH - MARGIN * 2), { x: MARGIN, y, size: 10, font: fonts.regular, color: rgb(0.4, 0.4, 0.4) });
  y -= lineHeight;
  for (const g of guests) {
    if (y < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    const name = fonts.text(g.guestName);
    const text = g.plusOneNames ? `•  ${name}  + ${fonts.text(g.plusOneNames)}` : `•  ${name}`;
    // TS-250: the table goes at the right, given up to 40% of the line (like the lookup list).
    let tableWidth = 0;
    if (g.tableLabel !== undefined) {
      const was = fitText(fonts.regular, wasAtText(fonts.text(g.tableLabel)), 11, lineWidth * 0.4);
      tableWidth = fonts.regular.widthOfTextAtSize(was, 11) + 16;
      page.drawText(was, { x: PAGE_WIDTH - MARGIN - tableWidth + 16, y, size: 11, font: fonts.regular, color: rgb(0.4, 0.4, 0.4) });
    }
    page.drawText(fitText(fonts.regular, text, 11, lineWidth - tableWidth), { x: MARGIN + 14, y, size: 11, font: fonts.regular });
    y -= lineHeight;
  }
  return { page, y };
}

/**
 * TS-211: the "Not seated" section -- every attending guest with no seat, so the door list and chart
 * never leave out someone who is coming.
 */
function drawNotSeated(
  doc: PDFDocument,
  page: PDFPage,
  y: number,
  fonts: Fonts,
  unseated: PdfExtras["unseated"]
): { page: PDFPage; y: number } {
  return drawGuestSection(doc, page, y, fonts, NOT_SEATED_HEADING, NOT_SEATED_NOTE, unseated ?? []);
}

/**
 * TS-250: the "Needs reassignment" section -- guests whose table no longer works for them, with the
 * table they were at, so nobody walks them to a seat that isn't really theirs.
 */
function drawNeedsReassignment(
  doc: PDFDocument,
  page: PDFPage,
  y: number,
  fonts: Fonts,
  flagged: ExportGuestRow[]
): { page: PDFPage; y: number } {
  return drawGuestSection(doc, page, y, fonts, NEEDS_REASSIGNMENT_HEADING, NEEDS_REASSIGNMENT_NOTE, flagged);
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
  // TS-250: guests whose seat needs changing, then (TS-211) guests with no seat.
  ({ page, y } = drawNeedsReassignment(doc, page, y, fonts, extras.needsReassignment ?? []));
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
  // TS-250: a guest whose seat needs changing isn't listed with that table -- see below.
  const { rows: seatedRows, flagged } = splitFlagged(rows, extras);
  rows = seatedRows.map((r) => safeRow(fonts, r));
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
  // TS-250: so whoever is on the door doesn't send a guest to a table that no longer works for them.
  ({ page, y } = drawNeedsReassignment(doc, page, y - 8, fonts, flagged));
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
  // TS-205: each line is measured once (at size 1, see unitWidth) and scaled for each size; the
  // best place to split is found from each word's width, measured once, added up. Before, every
  // possible split was laid out in full -- quadratic in the number of words.
  const widest = (lines: string[], size: number) => Math.max(...lines.map((l) => widthAt(font, l, size)));
  const options: string[][] = [[name]];
  const words = name.split(" ");
  if (words.length > 1) {
    const space = unitWidth(font, " ");
    const wordWidths = words.map((w) => unitWidth(font, w));
    const total = wordWidths.reduce((sum, w) => sum + w, 0) + space * (words.length - 1);
    let bestAt = 1;
    let bestWidest = Infinity;
    let left = -space;
    for (let i = 1; i < words.length; i++) {
      left += space + wordWidths[i - 1];
      const right = total - left - space;
      const pairWidest = Math.max(left, right);
      if (pairWidest < bestWidest) {
        bestWidest = pairWidest;
        bestAt = i;
      }
    }
    options.push([words.slice(0, bestAt).join(" "), words.slice(bestAt).join(" ")]);
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
  // TS-250: no card for a guest whose table no longer works for them -- a card would send them
  // there. They're listed on the last page instead (with the table they were at).
  const { rows: seatedRows, flagged } = splitFlagged(rows, extras);
  rows = seatedRows.map((r) => safeRow(fonts, r));
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

  const withoutCard = flagged.length > 0 || (extras.unseated?.length ?? 0) > 0;
  if (rows.length === 0 && !withoutCard) {
    doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  }
  // TS-211: guests with no seat get no card -- listed on a last page instead, so nobody is missed.
  // TS-250: ...and so do guests whose seat needs changing, under their own heading.
  if (withoutCard) {
    let last = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    last.drawText(fonts.text("Place cards — guests without a card"), { x: MARGIN, y: PAGE_HEIGHT - MARGIN - 20, size: 18, font: fonts.bold });
    let y = PAGE_HEIGHT - MARGIN - 44;
    ({ page: last, y } = drawNeedsReassignment(doc, last, y, fonts, flagged));
    drawNotSeated(doc, last, flagged.length > 0 ? y - 8 : y, fonts, extras.unseated);
  }
  // TS-211: the generated date and time on every page (cards have no header to carry it).
  // Just above the first row of cards.
  for (const p of doc.getPages()) drawGeneratedAt(p, fonts, extras.generatedAt, PAGE_HEIGHT - MARGIN + 8);

  return doc.save();
}
