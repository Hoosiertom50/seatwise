import {
  getWeddingAccessDetail,
  getWeddingById,
  type AccessLevel,
  type CollaboratorRole,
  type WeddingRow,
  type ActorAccess,
} from "@seatwise/db";
import { errorResponse } from "./api-response";

const RANK: Record<Exclude<AccessLevel, null>, number> = { VIEW: 1, COMMENT: 2, EDIT: 3, OWNER: 4 };

export interface GrantedAccess {
  wedding: WeddingRow;
  accessLevel: Exclude<AccessLevel, null>;
  /** The collaborator's role (null for the owner). */
  role: CollaboratorRole | null;
  /**
   * TS-204: the access this request was let in with, for the change to read again under its
   * lock (recheckActorAccess in packages/db) -- refused, nothing saved, if it dropped meanwhile.
   * Without the role: an ordinary change doesn't depend on being a Couple member.
   */
  actor: ActorAccess;
}

// TS-13: replaces the old pure-ownership check (getWeddingForOwner) across routes that a
// View/Comment/Edit collaborator should also be able to reach. minLevel is the lowest level that
// may proceed; OWNER always satisfies every minLevel.
// TS-204: the level and role are read once, together, and everything the route decides (including
// who may approve -- mayManageApproval below) is worked out from that one reading, the same one the
// change re-checks under its lock. Before, the approval routes read the role a second time.
export async function requireAccess(
  weddingId: string,
  userId: string,
  minLevel: Exclude<AccessLevel, null>
): Promise<GrantedAccess | { error: ReturnType<typeof errorResponse> }> {
  const { accessLevel, role } = await getWeddingAccessDetail(weddingId, userId);
  if (!accessLevel) {
    return { error: errorResponse("Wedding not found", 404) };
  }
  const wedding = await getWeddingById(weddingId);
  if (!wedding) {
    return { error: errorResponse("Wedding not found", 404) };
  }

  if (RANK[accessLevel] < RANK[minLevel]) {
    return { error: errorResponse("You don't have permission to do that", 403) };
  }

  return { wedding, accessLevel, role, actor: { userId, accessLevel } };
}

// TS-179: who may approve a plan, or undo an approval -- the wedding's owner, or a Couple member
// with Comment or Edit access. Shared by the status route and by Generate/Restore (which save a
// comparison draft instead of replacing an approved plan when this is false).
// TS-204: worked out from the request's one access reading (requireAccess), not read again.
export function mayManageApproval(access: Pick<GrantedAccess, "accessLevel" | "role">): boolean {
  if (access.accessLevel === "OWNER") return true;
  return access.role === "COUPLE" && access.accessLevel !== "VIEW";
}

/**
 * TS-204 (Tom's decision): the wedding's note is the owner's alone -- it's left out of the wedding
 * for everyone else, wherever a wedding is sent (the wedding itself, the dashboard's list). Before,
 * a View collaborator's browser received it with every wedding, though no screen showed it.
 */
export function weddingForViewer<T extends { ownerId: string; note?: string | null }>(
  wedding: T,
  viewerId: string
): T | Omit<T, "note"> {
  if (wedding.ownerId === viewerId) return wedding;
  const { note: _ownerOnly, ...rest } = wedding;
  void _ownerOnly;
  return rest;
}

// TS-195 / TS-204: the access an approval decision was made from, with the role -- read again
// under the lock, so a Couple member made a Collaborator (or lowered, or removed) while the change
// waited is refused. The same reading mayManageApproval used.
export function approvalActor(access: Pick<GrantedAccess, "accessLevel" | "role" | "actor">): ActorAccess {
  if (access.accessLevel === "OWNER") return access.actor;
  return { ...access.actor, role: access.role };
}
