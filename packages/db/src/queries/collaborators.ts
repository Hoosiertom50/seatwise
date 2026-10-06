import { randomUUID } from "crypto";
import { pool, beginTransaction } from "../pool";
import { lockWeddingRow } from "./wedding-lock";
import type { Queryable } from "./seat-checks";

// Ownership sits implicitly above EDIT — the owner never has a row in wedding_collaborators.
export type AccessLevel = "OWNER" | "EDIT" | "COMMENT" | "VIEW" | null;

const RANK: Record<Exclude<AccessLevel, null>, number> = {
  VIEW: 1,
  COMMENT: 2,
  EDIT: 3,
  OWNER: 4,
};

export function accessLevelMeets(level: AccessLevel, min: Exclude<AccessLevel, null>): boolean {
  if (!level) return false;
  return RANK[level] >= RANK[min];
}

export class CollaboratorError extends Error {
  constructor(
    message: string,
    public code: "NOT_FOUND" | "ALREADY_OWNER" | "ALREADY_COLLABORATOR" | "IS_OWNER" | "NOT_OWNER"
  ) {
    super(message);
    this.name = "CollaboratorError";
  }
}

export type CollaboratorRole = "COUPLE" | "COLLABORATOR";

export interface CollaboratorRow {
  id: string;
  weddingId: string;
  userId: string;
  userName: string;
  userEmail: string;
  role: CollaboratorRole;
  permissionLevel: "VIEW" | "COMMENT" | "EDIT";
  invitedByUserId: string | null;
  createdAt: Date;
}

// Central authorization check: OWNER (the wedding's ownerId), a collaborator's permissionLevel,
// or null if the user has no relationship to this wedding at all. Every route that isn't strictly
// owner-only (rename/delete wedding, manage collaborators) should gate on this instead of
// comparing ownerId directly, so View/Comment/Edit collaborators can reach the endpoints their
// level allows.
export async function getWeddingAccessLevel(weddingId: string, userId: string): Promise<AccessLevel> {
  const { rows: weddingRows } = await pool.query(`SELECT "ownerId" FROM "weddings" WHERE id = $1`, [
    weddingId,
  ]);
  const wedding = weddingRows[0];
  if (!wedding) return null;
  if (wedding.ownerId === userId) return "OWNER";

  const { rows: collabRows } = await pool.query(
    `SELECT "permissionLevel" FROM "wedding_collaborators" WHERE "weddingId" = $1 AND "userId" = $2`,
    [weddingId, userId]
  );
  const collab = collabRows[0];
  return collab ? (collab.permissionLevel as AccessLevel) : null;
}

// FR-1.4/FR-6.4: like getWeddingAccessLevel, but also returns the collaborator's role -- OWNER has
// no row of its own here and no role field, since the owner's approval authority is unconditional.
export async function getWeddingAccessDetail(
  weddingId: string,
  userId: string
): Promise<{ accessLevel: AccessLevel; role: CollaboratorRole | null }> {
  const { rows: weddingRows } = await pool.query(`SELECT "ownerId" FROM "weddings" WHERE id = $1`, [
    weddingId,
  ]);
  const wedding = weddingRows[0];
  if (!wedding) return { accessLevel: null, role: null };
  if (wedding.ownerId === userId) return { accessLevel: "OWNER", role: null };

  const { rows: collabRows } = await pool.query(
    `SELECT "permissionLevel", "role" FROM "wedding_collaborators" WHERE "weddingId" = $1 AND "userId" = $2`,
    [weddingId, userId]
  );
  const collab = collabRows[0];
  if (!collab) return { accessLevel: null, role: null };
  return { accessLevel: collab.permissionLevel as AccessLevel, role: collab.role as CollaboratorRole };
}

export async function listCollaboratorsForWedding(weddingId: string): Promise<CollaboratorRow[]> {
  const { rows } = await pool.query(
    `SELECT wc.id, wc."weddingId", wc."userId", u.name AS "userName", u.email AS "userEmail",
            wc."role", wc."permissionLevel", wc."invitedByUserId", wc."createdAt"
     FROM "wedding_collaborators" wc
     JOIN "users" u ON u.id = wc."userId"
     WHERE wc."weddingId" = $1
     ORDER BY wc."createdAt" ASC`,
    [weddingId]
  );
  return rows;
}

// Directly grants access to an already-registered account (no invite/acceptance step) -- the
// mechanism the invite-accept flow itself uses once an invite is confirmed, and still exposed as
// its own endpoint for a quick direct add. The user-facing "Invite a collaborator" flow on the
// Collaborators tab now goes through createInvite/acceptInvite instead (FR-1.4a), so this path no
// longer sends an invite email of its own.
export async function addCollaborator(
  weddingId: string,
  invitedByUserId: string,
  email: string,
  permissionLevel: "VIEW" | "COMMENT" | "EDIT",
  role: CollaboratorRole = "COLLABORATOR"
): Promise<CollaboratorRow> {
  // TS-148: emails are stored lowercased (see createUser), so look up the same way.
  const { rows: userRows } = await pool.query(`SELECT id, name, email FROM "users" WHERE email = $1`, [
    email.trim().toLowerCase(),
  ]);
  const user = userRows[0];
  if (!user) {
    throw new CollaboratorError("No Seatwise account exists with that email address.", "NOT_FOUND");
  }

  const { rows: weddingRows } = await pool.query(`SELECT "ownerId" FROM "weddings" WHERE id = $1`, [
    weddingId,
  ]);
  if (weddingRows[0]?.ownerId === user.id) {
    throw new CollaboratorError("That person already owns this wedding.", "ALREADY_OWNER");
  }

  const { rows: existingRows } = await pool.query(
    `SELECT id FROM "wedding_collaborators" WHERE "weddingId" = $1 AND "userId" = $2`,
    [weddingId, user.id]
  );
  if (existingRows[0]) {
    throw new CollaboratorError("That person is already a collaborator on this wedding.", "ALREADY_COLLABORATOR");
  }

  const id = randomUUID();
  await pool.query(
    `INSERT INTO "wedding_collaborators" (id, "weddingId", "userId", "role", "permissionLevel", "invitedByUserId")
     VALUES ($1, $2, $3, $4::"CollaboratorRole", $5::"CollaboratorPermission", $6)`,
    [id, weddingId, user.id, role, permissionLevel, invitedByUserId]
  );
  await revokePendingInvitesForUser(pool, weddingId, user.id);

  return {
    id,
    weddingId,
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    role,
    permissionLevel,
    invitedByUserId,
    createdAt: new Date(),
  };
}

// TS-195: the person asking isn't the wedding's owner any more (it was handed off a moment ago).
export const NOT_OWNER_ANY_MORE = "Only the wedding's owner can change who has access — and you aren't its owner any more.";

// TS-195: changing someone's access is the owner's -- checked again under the wedding's lock
// (FOR NO KEY UPDATE), which Generate, Restore, imports and the other access changes take too, so
// it waits for a change the person is making to finish (and that change re-reads their access).
// Before, it ran outside any transaction, after a check made a moment earlier: an owner who had
// just handed the wedding off could still change people's access.
export async function updateCollaboratorPermission(
  weddingId: string,
  collaboratorId: string,
  permissionLevel: "VIEW" | "COMMENT" | "EDIT" | undefined,
  role: CollaboratorRole | undefined,
  actorUserId: string
): Promise<void> {
  if (permissionLevel === undefined && role === undefined) {
    throw new CollaboratorError("Nothing to update.", "NOT_FOUND");
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (permissionLevel !== undefined) {
    params.push(permissionLevel);
    sets.push(`"permissionLevel" = $${params.length}::"CollaboratorPermission"`);
  }
  if (role !== undefined) {
    params.push(role);
    sets.push(`"role" = $${params.length}::"CollaboratorRole"`);
  }
  params.push(collaboratorId, weddingId);
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { ownerId } = await lockWeddingRow(client, weddingId);
    if (ownerId !== actorUserId) throw new CollaboratorError(NOT_OWNER_ANY_MORE, "NOT_OWNER");
    const { rows } = await client.query<{ userId: string }>(
      `UPDATE "wedding_collaborators" SET ${sets.join(", ")}
       WHERE id = $${params.length - 1} AND "weddingId" = $${params.length}
       RETURNING "userId"`,
      params
    );
    if (!rows[0]) throw new CollaboratorError("Collaborator not found.", "NOT_FOUND");
    await revokePendingInvitesForUser(client, weddingId, rows[0].userId);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// TS-148: a collaborator's access row (null when it isn't on this wedding) -- e.g. to let someone
// remove their own access.
export async function getCollaboratorForWedding(
  weddingId: string,
  collaboratorId: string
): Promise<{ id: string; userId: string } | null> {
  const { rows } = await pool.query(
    `SELECT id, "userId" FROM "wedding_collaborators" WHERE id = $1 AND "weddingId" = $2`,
    [collaboratorId, weddingId]
  );
  return rows[0] ?? null;
}

// TS-148: removing someone also cancels any invite still pending for them (accepting an old invite
// would otherwise bring the access straight back) and clears their notifications about this
// wedding (they name guests and changes the person may no longer see).
// TS-195: in one transaction (before, the three steps were separate, so a failure part-way left
// the invite or notifications behind), under the wedding's lock (as updateCollaboratorPermission),
// and only by the owner or the person themselves ("Leave") -- both checked under the lock. A
// collaborator leaving while the wedding is being handed to them finds they're now its owner
// (their access row went with the hand-off) and is told so.
export async function removeCollaborator(
  weddingId: string,
  collaboratorId: string,
  actorUserId: string,
  /** The person is removing their own access ("Leave"), as the route saw it. */
  { leaving = false }: { leaving?: boolean } = {}
): Promise<void> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { ownerId } = await lockWeddingRow(client, weddingId);
    const { rows: row } = await client.query<{ userId: string }>(
      `SELECT "userId" FROM "wedding_collaborators" WHERE id = $1 AND "weddingId" = $2`,
      [collaboratorId, weddingId]
    );
    if (!row[0]) {
      // Leaving, but the wedding was handed to them while this waited: they own it now.
      if (leaving && ownerId === actorUserId) {
        throw new CollaboratorError(
          "This wedding was just handed to you, so you're now its owner and can't leave it. To leave, hand it off to someone else first.",
          "IS_OWNER"
        );
      }
      throw new CollaboratorError("Collaborator not found.", "NOT_FOUND");
    }
    const removingSelf = row[0].userId === actorUserId;
    if (!removingSelf && ownerId !== actorUserId) throw new CollaboratorError(NOT_OWNER_ANY_MORE, "NOT_OWNER");
    await client.query(`DELETE FROM "wedding_collaborators" WHERE id = $1`, [collaboratorId]);
    await revokePendingInvitesForUser(client, weddingId, row[0].userId);
    await client.query(`DELETE FROM "notifications" WHERE "weddingId" = $1 AND "recipientUserId" = $2`, [
      weddingId,
      row[0].userId,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// TS-148: any invite still pending for this person on this wedding is cancelled whenever their
// access is set directly (added, changed or removed), so an older invite can never quietly undo
// that change when it's accepted later.
async function revokePendingInvitesForUser(q: Queryable, weddingId: string, userId: string): Promise<void> {
  await q.query(
    `UPDATE "wedding_invites" SET status = 'REVOKED'
     WHERE "weddingId" = $1 AND status = 'PENDING'
       AND lower(email) = (SELECT lower(email) FROM "users" WHERE id = $2)`,
    [weddingId, userId]
  );
}
