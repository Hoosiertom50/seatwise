import { databaseBusyResponse, errorResponse, weddingDeletedResponse } from "./api-response";

// TS-234: what a timeline edit or reorder says when it lost a race with another change -- the
// database broke a deadlock (40P01) or asked for a retry (40001). Nothing was saved.
export const TIMELINE_SAME_MOMENT_MESSAGE =
  "Someone else changed the timeline at the same moment — nothing was saved. Please try again.";

/**
 * TS-234: the answer for a timeline edit or reorder that was refused before it saved anything --
 * the wedding deleted meanwhile (404) or the person's access dropped (403), as before; a lost race
 * (409, as vendors does) instead of a server error; or the database too busy (503). Null for
 * anything else.
 */
export function timelineChangeRefusedResponse(err: unknown) {
  const refused = weddingDeletedResponse(err);
  if (refused) return refused;
  const code = (err as { code?: string } | null)?.code;
  if (code === "40P01" || code === "40001") return errorResponse(TIMELINE_SAME_MOMENT_MESSAGE, 409);
  return databaseBusyResponse(err);
}
