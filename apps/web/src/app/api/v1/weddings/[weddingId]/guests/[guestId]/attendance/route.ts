import { NextRequest, NextResponse } from "next/server";
import { setAttendanceSchema } from "@seatwise/shared";
import { setGuestAttendance, AttendanceError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; guestId: string }> };

// TS-11 (Day-Of Mode, FR-8.1): flip a guest's same-day attendance signal, independent of
// rsvpStatus. Marking someone Not Attending frees their seat immediately against the Current
// Plan Version — no full regeneration, nobody else moves — and excludes them from the
// unassigned/completeness count entirely. Reverting to Attending does NOT auto-seat them; they
// come back as Unassigned until someone explicitly (re)seats them. This route intentionally
// doesn't take a planVersionId — it always acts on whichever plan version is Current for the
// wedding, since attendance is a same-day, whole-wedding fact rather than something scoped to a
// specific version.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, guestId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = setAttendanceSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const planVersion = await setGuestAttendance(
      weddingId,
      guestId,
      parsed.data.attendance,
      user.id
    );
    return NextResponse.json({ planVersion });
  } catch (err) {
    if (err instanceof AttendanceError) {
      return errorResponse(err.message, 409);
    }
    throw err;
  }
}
