import { randomUUID } from "crypto";
import { pool } from "../pool";

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
    public code: "NOT_FOUND" | "ALREADY_OWNER" | "ALREADY_COLLABORATOR" | "IS_OWNER"
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
  const { rows: userRows } = await pool.query(`SELECT id, name, email FROM "users" WHERE email = $1`, [
    email,
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

// Upsert used by acceptInvite: if the invited address is already a collaborator (e.g. a re-invite
// at a different level), this updates their role/permission in place instead of erroring, since
// accepting an invite should never fail just because a relationship already exists.
export async function upsertCollaboratorByUserId(
  weddingId: string,
  userId: string,
  permissionLevel: "VIEW" | "COMMENT" | "EDIT",
  role: CollaboratorRole,
  invitedByUserId: string
): Promise<void> {
  await pool.query(
    `INSERT INTO "wedding_collaborators" (id, "weddingId", "userId", "role", "permissionLevel", "invitedByUserId")
     VALUES ($1, $2, $3, $4::"CollaboratorRole", $5::"CollaboratorPermission", $6)
     ON CONFLICT ("weddingId", "userId")
     DO UPDATE SET "role" = $4::"CollaboratorRole", "permissionLevel" = $5::"CollaboratorPermission"`,
    [randomUUID(), weddingId, userId, role, permissionLevel, invitedByUserId]
  );
}

export async function updateCollaboratorPermission(
  weddingId: string,
  collaboratorId: string,
  permissionLevel?: "VIEW" | "COMMENT" | "EDIT",
  role?: CollaboratorRole
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
  const { rowCount } = await pool.query(
    `UPDATE "wedding_collaborators" SET ${sets.join(", ")}
     WHERE id = $${params.length - 1} AND "weddingId" = $${params.length}`,
    params
  );
  if (!rowCount) {
    throw new CollaboratorError("Collaborator not found.", "NOT_FOUND");
  }
}

export async function removeCollaborator(weddingId: string, collaboratorId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `DELETE FROM "wedding_collaborators" WHERE id = $1 AND "weddingId" = $2`,
    [collaboratorId, weddingId]
  );
  if (!rowCount) {
    throw new CollaboratorError("Collaborator not found.", "NOT_FOUND");
  }
}
