import { NextRequest, NextResponse } from "next/server";
import { updateVendorSchema } from "@seatwise/shared";
import {
  updateVendorForWedding,
  deleteVendorForWedding,
  VendorConflictError,
  VendorCategoryOtherError,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse, readJson, weddingDeletedResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { vendorSameMomentResponse } from "@/lib/same-moment-answers";

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
    // TS-209: the vendor as saved comes back from the same transaction -- or none, when it was
    // deleted first (404). It used to be read afterwards, and a delete in between answered
    // {vendor: null}, which broke the Budget tab.
    const vendor = await updateVendorForWedding(vendorId, weddingId, data, expectedRevision, access.actor);
    if (!vendor) return errorResponse("Vendor not found", 404);
    return NextResponse.json({ vendor });
  } catch (err) {
    // FR-7.7, extended to vendors: someone else's edit landed on this vendor first -- refuse the
    // stale write and hand back the fresh vendor so the frontend can refresh in one step.
    if (err instanceof VendorConflictError) {
      return NextResponse.json({ error: err.message, vendor: err.vendor }, { status: 409 });
    }
    // TS-210: the "Other" label checked against the vendor's stored category.
    if (err instanceof VendorCategoryOtherError) {
      return errorResponse("Validation failed", 422, { categoryOther: [err.message] });
    }
    // TS-242: a lost race said in vendor words -- it used to get the plan's "changed this plan".
    const sameMoment = vendorSameMomentResponse(err);
    if (sameMoment) return sameMoment;
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
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
    // TS-242: a lost race is "try again" (409), not a server error.
    const sameMoment = vendorSameMomentResponse(err);
    if (sameMoment) return sameMoment;
    throw err;
  }
  if (!deleted) return errorResponse("Vendor not found", 404);

  return NextResponse.json({ ok: true });
}
