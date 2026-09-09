import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";

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
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

async function newDoc(): Promise<{ doc: PDFDocument; fonts: Fonts }> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  return { doc, fonts };
}

function drawHeader(page: PDFPage, fonts: Fonts, title: string, weddingName: string) {
  page.drawText(weddingName, {
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
  tables: { label: string; guestNames: string[] }[]
): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawHeader(page, fonts, "Seating Chart", weddingName);
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
    page.drawText(table.label, { x: MARGIN, y, size: 13, font: fonts.bold });
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
      page.drawText(`•  ${name}`, { x: MARGIN + 14, y, size: 11, font: fonts.regular });
      y -= lineHeight;
    }
    y -= 10;
  }

  return doc.save();
}

// FR-9.2: every guest, alphabetically, with their table — a fast lookup for whoever's on
// door/registration duty.
export async function buildLookupListPdf(
  weddingName: string,
  rows: ExportGuestRow[]
): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawHeader(page, fonts, "Guest Lookup List", weddingName);
  let y = PAGE_HEIGHT - MARGIN - 56;
  const lineHeight = 18;

  for (const row of rows) {
    if (y < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    page.drawText(row.guestName, { x: MARGIN, y, size: 11, font: fonts.regular });
    const tableText = row.tableLabel;
    const tableWidth = fonts.bold.widthOfTextAtSize(tableText, 11);
    page.drawText(tableText, {
      x: PAGE_WIDTH - MARGIN - tableWidth,
      y,
      size: 11,
      font: fonts.bold,
    });
    y -= lineHeight;
  }

  return doc.save();
}

// FR-9.3: one print-ready place/escort card per guest — name and table, cut lines, several to a
// page. Sized generously (roughly 3.6in x 2.3in) for readability over cramming the max per page.
export async function buildPlaceCardsPdf(rows: ExportGuestRow[]): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
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

    const nameSize = 18;
    const nameWidth = fonts.bold.widthOfTextAtSize(row.guestName, nameSize);
    page!.drawText(row.guestName, {
      x: x + (cardW - nameWidth) / 2,
      y: yTop - cardH / 2 - nameSize / 2 + 10,
      size: nameSize,
      font: fonts.bold,
    });

    const tableText = row.tableLabel;
    const tableSize = 12;
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

  if (rows.length === 0) {
    doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  }

  return doc.save();
}
