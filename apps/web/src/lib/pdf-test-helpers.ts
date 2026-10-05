// TS-158: shared by the PDF unit tests.
/** The BaseFont names of every font in a PDF. */
export async function fontNames(pdf: Uint8Array): Promise<string[]> {
  const { PDFDocument, PDFDict, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdf);
  const names: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Font")) {
      names.push(String(obj.get(PDFName.of("BaseFont"))));
    }
  }
  return names;
}
