import { NextRequest, NextResponse } from "next/server";
import { guestImportRequestSchema } from "@seatwise/shared";
import { commitGuestImport, GuestImportError, listGuestsByWedding, GuestImportConflictError, type UserRow } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse, readJson } from "@/lib/api-response";
import { requireAccess, type GrantedAccess } from "@/lib/access";
import { limitedWeddingWork, refusedButCounted } from "@/lib/rate-limit";
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

  // TS-205: an hourly limit per account on imports.
  return limitedWeddingWork("importCommit", user.id, () => commitImport(req, weddingId, user, access));
}

async function commitImport(req: NextRequest, weddingId: string, user: UserRow, access: GrantedAccess): Promise<Response> {

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
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
      // TS-204: the request's one access reading (requireAccess).
      access.actor,
      // TS-209: the same import sent again (its answer was lost) gets its first answer back.
      parsed.data.importKey
    );
  } catch (err) {
    // TS-92: a guest in the file was edited by someone else since the preview -- nothing saved.
    // TS-241: every such refusal comes after the whole file and guest list were read (classifyRows),
    // so it keeps its hourly count too -- giving it back let a full-size file be sent without limit.
    if (err instanceof GuestImportConflictError) {
      return refusedButCounted(errorResponse(err.message, 409));
    }
    // TS-209: with the rows that still have errors, so the screen can list them (it said "N rows
    // still have errors" and showed none).
    // TS-233: and, as a file refused after being read through, it still counts against the hourly
    // limit (busy and bad requests are still given back; TS-241: conflicts are counted, above).
    if (err instanceof GuestImportError) {
      return refusedButCounted(
        NextResponse.json({ error: err.message, ...(err.rows ? { rows: err.rows } : {}) }, { status: 422 })
      );
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
