import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { limitedWeddingWork } from "@/lib/rate-limit";
import { loadExportData, ExportNotFoundError, ExportNotReadyError } from "@/lib/export-data";
import { buildPlaceCardsPdf } from "@/lib/pdf";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// FR-9.3: one print-ready place/escort card per guest (name + table) as a PDF.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  // TS-225: an hourly limit per account on the PDFs (the three share it) -- a big wedding's PDF
  // takes seconds to make. A refused or failed try is given back.
  return limitedWeddingWork("pdfExport", user.id, async () => {
    try {
      // TS-211: with the guests who aren't seated (no card -- listed on a last page), and the date and
      // time it was made (in the time zone the browser sends).
      const { sortedRows, unseated, generatedAt } = await loadExportData(
        weddingId,
        planVersionId,
        user.id,
        req.nextUrl.searchParams.get("tz")
      );
      const pdfBytes = await buildPlaceCardsPdf(sortedRows, { unseated, generatedAt });
      return new NextResponse(Buffer.from(pdfBytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="place-cards.pdf"`,
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
