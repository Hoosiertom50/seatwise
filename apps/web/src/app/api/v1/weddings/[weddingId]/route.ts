import { NextRequest, NextResponse } from "next/server";
import { updateWeddingSchema, sideLabelsClash, SIDE_LABELS_MESSAGE } from "@seatwise/shared";
import { getWeddingById, updateWeddingForOwner, deleteWeddingForOwner } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, readJson, databaseBusyResponse } from "@/lib/api-response";
import { requireAccess, weddingForViewer } from "@/lib/access";
import { afterSave, SAVED_BUT_NOT_REFRESHED } from "@/lib/post-save";

type Params = { params: Promise<{ weddingId: string }> };

const SETTINGS_CONFLICT_MESSAGE =
  "This wedding's settings changed since you opened them (maybe in another tab) — showing the latest. Your change wasn't saved; make it again if it's still needed.";
const NO_LONGER_OWNER_MESSAGE = "Only the wedding's owner can change these settings — you aren't its owner any more.";

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  // TS-151: the caller's collaborator role too (null for the owner), so the page can offer Approve
  // to a Couple member with Comment access -- the server already allows it.
  // TS-204: read with the access level (requireAccess), and the note left out for anyone but the owner.
  return NextResponse.json({
    wedding: weddingForViewer(access.wedding, user.id),
    accessLevel: access.accessLevel,
    role: access.role,
  });
}

// Renaming/rescheduling the wedding is owner-only — collaborators (even Edit) can't touch these
// top-level settings.
export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = updateWeddingSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);
  // TS-190: a side name saved on its own must still differ from the other, stored one.
  const { sideLabel1, sideLabel2 } = parsed.data;
  if (
    (sideLabel1 !== undefined || sideLabel2 !== undefined) &&
    sideLabelsClash(sideLabel1 ?? access.wedding.sideLabel1, sideLabel2 ?? access.wedding.sideLabel2)
  ) {
    return errorResponse(SIDE_LABELS_MESSAGE, 422, { [sideLabel1 !== undefined ? "sideLabel1" : "sideLabel2"]: [SIDE_LABELS_MESSAGE] });
  }

  const { expectedRevision, ...changes } = parsed.data;
  const saved = await updateWeddingForOwner(weddingId, user.id, changes, expectedRevision);
  // TS-214: the settings changed since this copy was loaded (another tab, most likely) -- nothing
  // was saved; the latest settings come back so the screen can show them.
  // TS-258: the latest settings are read with their owner in the same row; someone who handed the
  // wedding off a moment ago is told so, and never gets the new owner's note.
  if (saved === "CONFLICT") {
    const latest = await getWeddingById(weddingId);
    if (!latest) return errorResponse("Wedding not found", 404);
    if (latest.ownerId !== user.id) return errorResponse(NO_LONGER_OWNER_MESSAGE, 403);
    return NextResponse.json(
      { error: SETTINGS_CONFLICT_MESSAGE, wedding: weddingForViewer(latest, user.id) },
      { status: 409 }
    );
  }
  // TS-195: the other side was renamed to this same name a moment ago (another tab) -- checked
  // again as it saves; nothing was saved.
  if (saved === "SIDE_LABELS_CLASH") {
    return errorResponse(SIDE_LABELS_MESSAGE, 422, { [sideLabel1 !== undefined ? "sideLabel1" : "sideLabel2"]: [SIDE_LABELS_MESSAGE] });
  }
  // TS-195: deleted, or handed to someone else, a moment ago -- nothing was saved (it used to answer
  // as if it had been).
  if (saved === "NOT_FOUND") {
    const wedding = await getWeddingById(weddingId);
    return wedding
      ? errorResponse(NO_LONGER_OWNER_MESSAGE, 403)
      : errorResponse("Wedding not found", 404);
  }
  // TS-209 (Copilot review): saved by now -- if reading it back fails, the answer is still success:
  // the settings as they were plus this change, at the next settings version, with a "refresh"
  // warning. It used to be a server error for a change that had been saved.
  const warnings: string[] = [];
  const wedding = await afterSave("reading the wedding back", () => getWeddingById(weddingId), warnings, SAVED_BUT_NOT_REFRESHED, null);
  return NextResponse.json({
    // TS-258: handed off just after the save, the read-back leaves out the new owner's note.
    wedding: (wedding && weddingForViewer(wedding, user.id)) ?? {
      ...access.wedding,
      ...changes,
      settingsRevision: (expectedRevision ?? access.wedding.settingsRevision) + 1,
    },
    warnings,
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  // TS-209: a delete that lost a race with another change (a deadlock the database broke, or the
  // plan replaced while it waited) deleted nothing -- "try again" (409), not a server error.
  let deleted: Awaited<ReturnType<typeof deleteWeddingForOwner>>;
  try {
    deleted = await deleteWeddingForOwner(weddingId, user.id);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "40P01" || code === "40001") {
      return errorResponse("Someone was changing this wedding at the same moment, so it wasn't deleted. Please try again.", 409);
    }
    const busy = databaseBusyResponse(err);
    if (busy) return busy;
    throw err;
  }
  // TS-255: handed off between the owner check and the delete -- not deleted, and not "not found"
  // either, so a retrying screen doesn't treat it as done.
  if (deleted === "not-owner") {
    return errorResponse("Only the wedding's owner can delete it — you aren't its owner any more.", 403);
  }
  if (deleted === "gone") return errorResponse("Wedding not found", 404);

  return NextResponse.json({ ok: true });
}
