import { NextRequest, NextResponse } from "next/server";
import { createWeddingSchema } from "@seatwise/shared";
import { createWedding, listWeddingsWithSummaryForUser, TemplateNotFoundError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";

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

  const body = await req.json().catch(() => null);
  const parsed = createWeddingSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-19 (FR-14.4): templateId is validated against this same user's own templates inside
  // createWedding -- a template belongs to whoever saved it, so this is the one place ownership
  // is checked, rather than a separate lookup here.
  try {
    const wedding = await createWedding(user.id, parsed.data);
    return NextResponse.json({ wedding }, { status: 201 });
  } catch (err) {
    if (err instanceof TemplateNotFoundError) return errorResponse(err.message, 404);
    throw err;
  }
}
