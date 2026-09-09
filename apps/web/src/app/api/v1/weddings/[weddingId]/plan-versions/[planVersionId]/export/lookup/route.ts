import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { loadExportData, ExportNotFoundError, ExportNotReadyError } from "@/lib/export-data";
import { buildLookupListPdf } from "@/lib/pdf";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// FR-9.2: every guest, alphabetically, with their table, as a PDF.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  try {
    const { weddingName, sortedRows } = await loadExportData(weddingId, planVersionId, user.id);
    const pdfBytes = await buildLookupListPdf(weddingName, sortedRows);
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="guest-lookup-list.pdf"`,
      },
    });
  } catch (err) {
    if (err instanceof ExportNotFoundError) return errorResponse(err.message, 404);
    if (err instanceof ExportNotReadyError) return errorResponse(err.message, 409);
    throw err;
  }
}
