import { NextRequest, NextResponse } from "next/server";
import { guestImportRequestSchema } from "@seatwise/shared";
import { classifyGuestImport, GuestImportError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, readJson } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { limitedWeddingWork, refusedButCounted } from "@/lib/rate-limit";

type Params = { params: Promise<{ weddingId: string }> };

// FR-2.4a: writes nothing -- classifies every data row as new/updating/error so the UI can show
// the split before anything is confirmed.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // TS-225: an hourly limit per account on previews (each reads the whole file and every guest). A
  // refused or failed try is given back -- TS-233: apart from a file refused once it was read.
  return limitedWeddingWork("importPreview", user.id, () => previewImport(req, weddingId));
}

async function previewImport(req: NextRequest, weddingId: string): Promise<Response> {
  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = guestImportRequestSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const preview = await classifyGuestImport(weddingId, parsed.data.csv, parsed.data.mapping);
    return NextResponse.json({ preview });
  } catch (err) {
    // TS-233: a file refused after being read through still counts against the hourly limit.
    if (err instanceof GuestImportError) return refusedButCounted(errorResponse(err.message, 422));
    throw err;
  }
}
