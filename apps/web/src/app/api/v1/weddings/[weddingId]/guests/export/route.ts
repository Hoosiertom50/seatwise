import { NextRequest } from "next/server";
import { toCsv } from "@seatwise/shared";
import { listGuestsByWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

const HEADERS = [
  "Guest ID",
  "First name",
  "Last name",
  "Party / household",
  "Headcount",
  "Tier",
  "RSVP status",
  "Requires accessible table",
  "Attendance",
  "Side",
  "Notes",
];

// Exists so a bulk *update* import (FR-2.4a) has a Guest ID to map back in the first place --
// there's no other way for a planner to ever see one, since IDs are never shown in the UI.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const guests = await listGuestsByWedding(weddingId);
  const rows = guests.map((g) => [
    g.id,
    g.firstName,
    g.lastName,
    g.partyName ?? "",
    String(g.headcount),
    g.tier,
    g.rsvpStatus,
    g.requiresAccessibleTable ? "Yes" : "No",
    g.dayOfAttendance,
    g.side,
    g.notes ?? "",
  ]);
  const csv = toCsv(HEADERS, rows);

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="guest-list.csv"`,
    },
  });
}
