import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { limitedWeddingWork } from "@/lib/rate-limit";
import { loadExportData, ExportNotFoundError, ExportNotReadyError } from "@/lib/export-data";
import { buildLookupListPdf } from "@/lib/pdf";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// FR-9.2: every guest, alphabetically, with their table, as a PDF.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  // TS-225: an hourly limit per account on the PDFs (the three share it) -- a big wedding's PDF
  // takes seconds to make. A refused or failed try is given back.
  return limitedWeddingWork("pdfExport", user.id, async () => {
    try {
      // TS-211: with the guests who aren't seated, and the date and time it was made (in the time zone
      // the browser sends).
      // TS-250: and, listed on their own, the guests whose seat needs changing since approval.
      const { weddingName, sortedRows, unseated, needsReassignment, generatedAt } = await loadExportData(
        weddingId,
        planVersionId,
        user.id,
        req.nextUrl.searchParams.get("tz")
      );
      const pdfBytes = await buildLookupListPdf(weddingName, sortedRows, { unseated, needsReassignment, generatedAt });
      return new NextResponse(Buffer.from(pdfBytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="guest-lookup-list.pdf"`,
          // TS-190: guests' names -- not kept in the browser's or any shared cache.
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      if (err instanceof ExportNotFoundError) return errorResponse(err.message, 404);
      if (err instanceof ExportNotReadyError) return errorResponse(err.message, 409);
      throw err;
    }
  });
}
