import type { Queryable } from "./seat-checks";
import type { AccessLevel, CollaboratorRole } from "./collaborators";

// TS-195: things every change that runs at the same moment as another one needs -- the wedding's
// own lock, telling "the wedding was deleted meanwhile" apart from other failures, and checking
// again, under the lock, that the person still has the access they were let in with.

/** The wedding was deleted while this change waited or ran. Nothing was saved. */
export class WeddingDeletedError extends Error {
  constructor() {
    super("This wedding was deleted — nothing was saved.");
  }
}

/**
 * TS-195: true for a WeddingDeletedError, or for the database refusing to save a row because its
 * wedding no longer exists (a guest, table, plan... added while the wedding was being deleted --
 * the delete wins and the new row has nowhere to go).
 */
export function isWeddingDeletedError(err: unknown): boolean {
  if (err instanceof WeddingDeletedError) return true;
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === "23503" && typeof e.constraint === "string" && /_weddingId_fkey$/.test(e.constraint);
}

/**
 * TS-195: the wedding's row lock (FOR NO KEY UPDATE, like every other wedding lock -- see TS-185),
 * taken first, before the current plan, the lists and any other row. Throws WeddingDeletedError if
 * the wedding is gone. Returns its owner as it is under the lock.
 */
export async function lockWeddingRow(q: Queryable, weddingId: string): Promise<{ ownerId: string }> {
  const { rows } = await q.query(`SELECT "ownerId" FROM "weddings" WHERE id = $1 FOR NO KEY UPDATE`, [weddingId]);
  if (!rows[0]) throw new WeddingDeletedError();
  return { ownerId: rows[0].ownerId as string };
}

/** The access a request was let in with (what the route checked before the change started). */
export interface ActorAccess {
  userId: string;
  accessLevel: Exclude<AccessLevel, null>;
  /** The collaborator's role, when it mattered for the decision (approving needs Couple). */
  role?: CollaboratorRole | null;
}

/** TS-195: the person's access was lowered or removed while their change was being saved. */
export class AccessChangedError extends Error {
  constructor() {
    super("Your access to this wedding changed while this was being saved — nothing was saved. Refresh to see what you can do now.");
  }
}

const RANK: Record<Exclude<AccessLevel, null>, number> = { VIEW: 1, COMMENT: 2, EDIT: 3, OWNER: 4 };

/**
 * TS-195: reads the person's access again inside a long change (Generate, Restore, an approval,
 * an import), after its locks, and refuses -- nothing saved -- if it dropped below what the route
 * let them in with. A collaborator's row is share-locked (FOR KEY SHARE), so removing them waits
 * for this change to finish; changing their level takes the wedding's lock, which Generate,
 * Restore and imports already hold. Before, the route checked access once, before a change that
 * could wait seconds for its locks -- someone removed in that moment still had it saved.
 */
export async function recheckActorAccess(q: Queryable, weddingId: string, actor: ActorAccess): Promise<void> {
  const { rows: wedding } = await q.query(`SELECT "ownerId" FROM "weddings" WHERE id = $1`, [weddingId]);
  if (!wedding[0]) throw new WeddingDeletedError();
  if (wedding[0].ownerId === actor.userId) return; // the owner has every level
  const { rows } = await q.query(
    `SELECT "permissionLevel", role FROM "wedding_collaborators" WHERE "weddingId" = $1 AND "userId" = $2 FOR KEY SHARE`,
    [weddingId, actor.userId]
  );
  const now = rows[0] as { permissionLevel: Exclude<AccessLevel, null | "OWNER">; role: CollaboratorRole } | undefined;
  const dropped =
    !now ||
    RANK[now.permissionLevel] < RANK[actor.accessLevel] ||
    (actor.accessLevel !== "OWNER" && actor.role === "COUPLE" && now.role !== "COUPLE");
  if (dropped) throw new AccessChangedError();
}
