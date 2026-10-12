import { NextRequest } from "next/server";
import { toCsv, guestSideLabel } from "@seatwise/shared";
import { listGuestsByWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { guestForViewer } from "@/lib/guest-privacy";

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
  // TS-107: last, so the columns an update import maps by name keep their positions. Import never
  // maps this one -- a guest's own RSVP note is only ever written through their RSVP link.
  "Guest's RSVP note",
  // TS-180: who's coming with the guest (an update import maps it back), and the guest's revision
  // when exported -- re-importing an older file then shows guests changed since, rather than
  // quietly undoing those changes. Both last, for the same reason as above.
  "Plus-ones",
  "Version",
  // TS-190: the guest's age category (an update import maps it back). Last, for the same reason.
  "Age category",
  // TS-210: the stored side (BRIDE / GROOM / BOTH), which the import prefers to the Side name -- the
  // names can be renamed between the export and the re-import. Last, for the same reason.
  "Side code",
];

// Exists so a bulk *update* import (FR-2.4a) has a Guest ID to map back in the first place --
// there's no other way for a planner to ever see one, since IDs are never shown in the UI.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  // TS-154: the notes columns are blank for View and Comment collaborators.
  const guests = (await listGuestsByWedding(weddingId)).map((g) => guestForViewer(g, access.accessLevel));
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
    // TS-180: the wedding's own name for the side (as the import reads it), not BRIDE / GROOM --
    // a wedding whose first side is called "Groom" swapped every guest's side on re-import.
    guestSideLabel(g.side, access.wedding.sideLabel1, access.wedding.sideLabel2),
    g.notes ?? "",
    g.rsvpNotes ?? "",
    // TS-180: plus-ones stay visible to View and Comment collaborators, as in the app.
    g.plusOneNames ?? "",
    String(g.revision),
    g.ageCategory,
    g.side,
  ]);
  // TS-180: starts with a byte-order mark (see toCsv), so Excel shows accented names correctly.
  const csv = toCsv(HEADERS, rows);

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="guest-list.csv"`,
      // TS-180: the guest list (with private notes for some) is never kept in a shared cache.
      "Cache-Control": "no-store",
    },
  });
}
