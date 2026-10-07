import { NextRequest, NextResponse } from "next/server";
import { createWeddingSchema } from "@seatwise/shared";
import { createWedding, listWeddingsWithSummaryForUser, TemplateNotFoundError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, readJson } from "@/lib/api-response";
import { countOr429, TOO_MANY_WEDDINGS_TODAY, WEDDING_CREATE_LIMITS, weddingCreateKey } from "@/lib/rate-limit";

// FR-11.1/FR-11.2: the dashboard's list now carries each wedding's plan status and
// unassigned/Needs Reassignment counts (WeddingSummaryDTO), not just the plain WeddingDTO fields.
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const weddings = await listWeddingsWithSummaryForUser(user.id);
  return NextResponse.json({ weddings });
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = createWeddingSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-178: a few new weddings per account a day (see WEDDING_CREATE_LIMITS).
  // TS-194: given back from exactly the window it was counted in, if no wedding is made.
  const { limited, giveBack } = await countOr429(weddingCreateKey(user.id), WEDDING_CREATE_LIMITS.perAccountDay, TOO_MANY_WEDDINGS_TODAY);
  if (limited) return limited;

  // TS-19 (FR-14.4): templateId is validated against this same user's own templates inside
  // createWedding -- a template belongs to whoever saved it, so this is the one place ownership
  // is checked, rather than a separate lookup here.
  try {
    const wedding = await createWedding(user.id, parsed.data);
    return NextResponse.json({ wedding }, { status: 201 });
  } catch (err) {
    // TS-178: no wedding was made, so it doesn't count.
    await giveBack();
    if (err instanceof TemplateNotFoundError) return errorResponse(err.message, 404);
    throw err;
  }
}
