import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { loadExportData, ExportNotFoundError, ExportNotReadyError } from "@/lib/export-data";
import { buildSeatingChartPdf } from "@/lib/pdf";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// FR-9.1: the full seating chart, table by table, as a PDF.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  try {
    const { weddingName, tables } = await loadExportData(weddingId, planVersionId, user.id);
    const pdfBytes = await buildSeatingChartPdf(weddingName, tables);
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="seating-chart.pdf"`,
      },
    });
  } catch (err) {
    if (err instanceof ExportNotFoundError) return errorResponse(err.message, 404);
    if (err instanceof ExportNotReadyError) return errorResponse(err.message, 409);
    throw err;
  }
}
