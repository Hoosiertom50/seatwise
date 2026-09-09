import { NextRequest, NextResponse } from "next/server";
import { updateVendorSchema } from "@seatwise/shared";
import {
  updateVendorForWedding,
  getVendorForWedding,
  deleteVendorForWedding,
  VendorConflictError,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; vendorId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, vendorId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = updateVendorSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const { expectedRevision, ...data } = parsed.data;
  try {
    const updated = await updateVendorForWedding(vendorId, weddingId, data, expectedRevision);
    if (!updated) return errorResponse("Vendor not found", 404);
  } catch (err) {
    // FR-7.7, extended to vendors: someone else's edit landed on this vendor first -- refuse the
    // stale write and hand back the fresh vendor so the frontend can refresh in one step.
    if (err instanceof VendorConflictError) {
      return NextResponse.json({ error: err.message, vendor: err.vendor }, { status: 409 });
    }
    throw err;
  }

  const vendor = await getVendorForWedding(vendorId, weddingId);
  return NextResponse.json({ vendor });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, vendorId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const deleted = await deleteVendorForWedding(vendorId, weddingId);
  if (!deleted) return errorResponse("Vendor not found", 404);

  return NextResponse.json({ ok: true });
}
