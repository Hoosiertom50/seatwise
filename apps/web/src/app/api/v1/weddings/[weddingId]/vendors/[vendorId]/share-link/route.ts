import { NextRequest, NextResponse } from "next/server";
import { vendorShareLinkActionSchema, type VendorShareLinkDTO } from "@seatwise/shared";
import {
  getVendorForWedding,
  ensureVendorShareToken,
  regenerateVendorShareToken,
  revokeVendorShareToken,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; vendorId: string }> };

// TS-114: a vendor's private read-only link -- EDIT access to get it, replace it (the old one stops
// working) or turn it off. Like the guest RSVP link, the token is only ever handed out here, never
// through the normal vendor read path.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, vendorId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => ({}));
  const parsed = vendorShareLinkActionSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  if (!(await getVendorForWedding(vendorId, weddingId))) return errorResponse("Vendor not found", 404);
  const token = parsed.data.regenerate
    ? await regenerateVendorShareToken(vendorId, weddingId)
    : await ensureVendorShareToken(vendorId, weddingId);
  if (!token) return errorResponse("Vendor not found", 404);

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const result: VendorShareLinkDTO = { url: `${appUrl}/vendor/${token}` };
  return NextResponse.json({ link: result });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, vendorId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  if (!(await revokeVendorShareToken(vendorId, weddingId))) return errorResponse("Vendor not found", 404);
  return NextResponse.json({ ok: true });
}
