import { NextRequest, NextResponse } from "next/server";
import { guestImportRequestSchema } from "@seatwise/shared";
import { commitGuestImport, GuestImportError, listGuestsByWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// FR-2.4: applies the confirmed import as one all-or-nothing operation -- re-validates from
// scratch (never trusting the client's earlier preview) and writes nothing at all if any row
// still has an error.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = guestImportRequestSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const result = await commitGuestImport(weddingId, parsed.data.csv, parsed.data.mapping);
    const guests = await listGuestsByWedding(weddingId);
    return NextResponse.json({ result, guests });
  } catch (err) {
    if (err instanceof GuestImportError) {
      return errorResponse(err.message, 422);
    }
    throw err;
  }
}
