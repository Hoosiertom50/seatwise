import { NextRequest, NextResponse } from "next/server";
import { copiedWeddingName, duplicateWeddingSchema } from "@seatwise/shared";
import { duplicateWeddingLayout, getWeddingById } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// TS-91: starts a new wedding (owned by you) from this one's room layout and seating settings,
// so a planner reusing a venue doesn't rebuild the floor plan. Owner-only: the copy becomes your
// own wedding, and the source's guests, rules and plans are never copied.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => ({}));
  const parsed = duplicateWeddingSchema.safeParse(body ?? {});
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const source = await getWeddingById(weddingId);
  if (!source) return errorResponse("Wedding not found", 404);
  // TS-168: "(copy)" isn't allowed in a wedding name (so emails for the copy fell back to "a
  // wedding"), and could take a long name past the limit.
  const name = parsed.data.name ?? copiedWeddingName(source.name);

  const newId = await duplicateWeddingLayout(weddingId, user.id, name);
  if (!newId) return errorResponse("Wedding not found", 404);
  const wedding = await getWeddingById(newId);
  return NextResponse.json({ wedding }, { status: 201 });
}
