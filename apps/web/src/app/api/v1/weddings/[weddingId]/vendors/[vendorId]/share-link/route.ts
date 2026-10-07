import { NextRequest, NextResponse } from "next/server";
import { vendorShareLinkActionSchema, type VendorShareLinkDTO } from "@seatwise/shared";
import {
  getVendorForWedding,
  ensureVendorShareToken,
  regenerateVendorShareToken,
  revokeVendorShareToken,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { appBaseUrl } from "@/lib/app-url";
import { errorResponse, zodErrorResponse, readJson } from "@/lib/api-response";
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

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body ?? {};
  const parsed = vendorShareLinkActionSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  if (!(await getVendorForWedding(vendorId, weddingId))) return errorResponse("Vendor not found", 404);
  // TS-178: the app's own address (see lib/app-url), worked out before the link is changed.
  const appUrl = appBaseUrl();
  const token = parsed.data.regenerate
    ? await regenerateVendorShareToken(vendorId, weddingId)
    : await ensureVendorShareToken(vendorId, weddingId);
  if (!token) return errorResponse("Vendor not found", 404);

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
