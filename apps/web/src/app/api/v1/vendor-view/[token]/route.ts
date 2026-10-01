import { NextRequest, NextResponse } from "next/server";
import type { VendorViewDTO } from "@seatwise/shared";
import { getVendorViewByToken } from "@seatwise/db";
import { clientAddress, rateLimitOr429, VENDOR_LINK_LIMITS } from "@/lib/rate-limit";

type Params = { params: Promise<{ token: string }> };

// TS-114: what a vendor's read-only link shows -- no sign-in, rate-limited per address like the
// RSVP link. A made-up or turned-off link answers ACTIVE: false with nothing else, so it can't be
// used to learn anything about a wedding. Never cached: the planner's latest timeline shows every
// time the vendor opens it.
export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params;
  const limited = await rateLimitOr429(`vendor-link:addr:${clientAddress(req)}`, VENDOR_LINK_LIMITS.perAddress);
  if (limited) return limited;

  const view = await getVendorViewByToken(token);
  const headers = { "Cache-Control": "no-store" };
  if (!view) return NextResponse.json({ active: false }, { headers });
  return NextResponse.json({ active: true, view: view as VendorViewDTO }, { headers });
}
