import { inflateSync } from "node:zlib";

/**
 * TS-158: the names of the fonts a PDF uses (its /BaseFont entries), so a test can tell which font
 * an export was drawn with. Looks in the file as-is and inside every compressed stream.
 */
export function pdfFontNames(pdf: Buffer): string[] {
  const raw = pdf.toString("latin1");
  const texts = [raw];
  const streams = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streams.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    try {
      texts.push(inflateSync(pdf.subarray(start, end)).toString("latin1"));
    } catch {
      // not a compressed stream (or not one that holds dictionaries) -- nothing to read
    }
  }
  const names = new Set<string>();
  for (const text of texts) {
    for (const f of text.matchAll(/\/BaseFont\s*\/([^\s/<>[\]()]+)/g)) names.add(f[1]);
  }
  return [...names];
}
