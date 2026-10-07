import { NextRequest, NextResponse } from "next/server";
import { updateVendorSchema } from "@seatwise/shared";
import {
  updateVendorForWedding,
  getVendorForWedding,
  deleteVendorForWedding,
  VendorConflictError,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, readJson, weddingDeletedResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; vendorId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, vendorId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = updateVendorSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const { expectedRevision, ...data } = parsed.data;
  try {
    const updated = await updateVendorForWedding(vendorId, weddingId, data, expectedRevision, access.actor);
    if (!updated) return errorResponse("Vendor not found", 404);
  } catch (err) {
    // FR-7.7, extended to vendors: someone else's edit landed on this vendor first -- refuse the
    // stale write and hand back the fresh vendor so the frontend can refresh in one step.
    if (err instanceof VendorConflictError) {
      return NextResponse.json({ error: err.message, vendor: err.vendor }, { status: 409 });
    }
    // TS-204: access dropped while it waited (403), or the wedding was deleted (404) -- nothing saved.
    const refused = weddingDeletedResponse(err);
    if (refused) return refused;
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

  let deleted: boolean;
  try {
    deleted = await deleteVendorForWedding(vendorId, weddingId, access.actor);
  } catch (err) {
    // TS-204: access dropped while it waited (403), or the wedding was deleted (404) -- nothing saved.
    const refused = weddingDeletedResponse(err);
    if (refused) return refused;
    throw err;
  }
  if (!deleted) return errorResponse("Vendor not found", 404);

  return NextResponse.json({ ok: true });
}
