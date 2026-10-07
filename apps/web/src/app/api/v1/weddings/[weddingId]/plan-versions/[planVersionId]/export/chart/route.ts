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
    // TS-211: with the guests who aren't seated, and the date and time it was made (in the time zone
    // the browser sends).
    const { weddingName, tables, unseated, generatedAt } = await loadExportData(
      weddingId,
      planVersionId,
      user.id,
      req.nextUrl.searchParams.get("tz")
    );
    const pdfBytes = await buildSeatingChartPdf(weddingName, tables, { unseated, generatedAt });
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="seating-chart.pdf"`,
        // TS-190: guests' names -- not kept in the browser's or any shared cache.
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ExportNotFoundError) return errorResponse(err.message, 404);
    if (err instanceof ExportNotReadyError) return errorResponse(err.message, 409);
    throw err;
  }
}
