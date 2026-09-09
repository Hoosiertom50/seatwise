import { getWeddingAccessLevel, getWeddingById, type AccessLevel, type WeddingRow } from "@seatwise/db";
import { errorResponse } from "./api-response";

// TS-13: replaces the old pure-ownership check (getWeddingForOwner) across routes that a
// View/Comment/Edit collaborator should also be able to reach. minLevel is the lowest level that
// may proceed; OWNER always satisfies every minLevel.
export async function requireAccess(
  weddingId: string,
  userId: string,
  minLevel: Exclude<AccessLevel, null>
): Promise<{ wedding: WeddingRow; accessLevel: AccessLevel } | { error: ReturnType<typeof errorResponse> }> {
  const accessLevel = await getWeddingAccessLevel(weddingId, userId);
  if (!accessLevel) {
    return { error: errorResponse("Wedding not found", 404) };
  }
  const wedding = await getWeddingById(weddingId);
  if (!wedding) {
    return { error: errorResponse("Wedding not found", 404) };
  }

  const RANK: Record<Exclude<AccessLevel, null>, number> = { VIEW: 1, COMMENT: 2, EDIT: 3, OWNER: 4 };
  if (RANK[accessLevel] < RANK[minLevel]) {
    return { error: errorResponse("You don't have permission to do that", 403) };
  }

  return { wedding, accessLevel };
}
