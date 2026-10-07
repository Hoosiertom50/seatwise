import { NextRequest, NextResponse } from "next/server";
import { guestImportRequestSchema } from "@seatwise/shared";
import { commitGuestImport, GuestImportError, listGuestsByWedding, GuestImportConflictError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse } from "@/lib/api-response";
import { requireAccess, actorAccessFor } from "@/lib/access";
import { guestForViewer } from "@/lib/guest-privacy";
import { SAVED_BUT_NOT_REFRESHED, afterSave } from "@/lib/post-save";

type Params = { params: Promise<{ weddingId: string }> };

// FR-2.4: applies the confirmed import as one all-or-nothing operation -- re-validates from
// scratch (never trusting the client's earlier preview) and writes nothing at all if any row
// still has an error.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = guestImportRequestSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  let result: Awaited<ReturnType<typeof commitGuestImport>>;
  try {
    result = await commitGuestImport(
      weddingId,
      parsed.data.csv,
      parsed.data.mapping,
      parsed.data.expectedRevisions,
      user.id,
      // TS-180: write guests changed since the export only when the planner ticked to overwrite.
      parsed.data.overwriteChanged ?? false,
      // TS-195: read again under the import's lock -- refused if it dropped meanwhile.
      await actorAccessFor(weddingId, user.id, access.accessLevel),
      // TS-209: the same import sent again (its answer was lost) gets its first answer back.
      parsed.data.importKey
    );
  } catch (err) {
    // TS-92: a guest in the file was edited by someone else since the preview -- nothing saved.
    if (err instanceof GuestImportConflictError) {
      return errorResponse(err.message, 409);
    }
    // TS-209: with the rows that still have errors, so the screen can list them (it said "N rows
    // still have errors" and showed none).
    if (err instanceof GuestImportError) {
      return NextResponse.json({ error: err.message, ...(err.rows ? { rows: err.rows } : {}) }, { status: 422 });
    }
    // TS-187: lost a race with another change (nothing saved) -- 409, not a server error.
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
  // TS-209: the import is saved -- reading the list back can't turn it into an error (the screen
  // said it failed, and importing again added every new guest twice). Without the list, the screen
  // loads it itself.
  const warnings: string[] = [];
  const guests = await afterSave(
    "reading the guest list back after an import",
    async () => (await listGuestsByWedding(weddingId)).map((g) => guestForViewer(g, access.accessLevel)),
    warnings,
    SAVED_BUT_NOT_REFRESHED,
    null
  );
  return NextResponse.json({ result, guests, warnings });
}
