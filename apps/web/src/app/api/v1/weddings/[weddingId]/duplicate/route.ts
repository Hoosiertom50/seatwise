import { NextRequest, NextResponse } from "next/server";
import { copiedWeddingName, duplicateWeddingSchema } from "@seatwise/shared";
import { duplicateWeddingLayout, getWeddingById } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, readJson } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { countOr429, TOO_MANY_WEDDINGS_TODAY, WEDDING_CREATE_LIMITS, weddingCreateKey } from "@/lib/rate-limit";

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

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body ?? {};
  const parsed = duplicateWeddingSchema.safeParse(body ?? {});
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const source = await getWeddingById(weddingId);
  if (!source) return errorResponse("Wedding not found", 404);
  // TS-168: "(copy)" isn't allowed in a wedding name (so emails for the copy fell back to "a
  // wedding"), and could take a long name past the limit.
  const name = parsed.data.name ?? copiedWeddingName(source.name);

  // TS-178: a copy is a new wedding too, so it counts toward the same daily cap.
  // TS-194: given back from exactly the window it was counted in, if no copy is made -- including
  // when making it fails.
  const { limited, giveBack } = await countOr429(weddingCreateKey(user.id), WEDDING_CREATE_LIMITS.perAccountDay, TOO_MANY_WEDDINGS_TODAY);
  if (limited) return limited;
  let newId: string | null;
  try {
    newId = await duplicateWeddingLayout(weddingId, user.id, name);
  } catch (err) {
    await giveBack();
    throw err;
  }
  if (!newId) {
    await giveBack();
    return errorResponse("Wedding not found", 404);
  }
  const wedding = await getWeddingById(newId);
  return NextResponse.json({ wedding }, { status: 201 });
}
