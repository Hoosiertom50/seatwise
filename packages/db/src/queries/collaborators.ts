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

export interface CollaboratorRow {
  id: string;
  weddingId: string;
  userId: string;
  userName: string;
  userEmail: string;
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

export async function listCollaboratorsForWedding(weddingId: string): Promise<CollaboratorRow[]> {
  const { rows } = await pool.query(
    `SELECT wc.id, wc."weddingId", wc."userId", u.name AS "userName", u.email AS "userEmail",
            wc."permissionLevel", wc."invitedByUserId", wc."createdAt"
     FROM "wedding_collaborators" wc
     JOIN "users" u ON u.id = wc."userId"
     WHERE wc."weddingId" = $1
     ORDER BY wc."createdAt" ASC`,
    [weddingId]
  );
  return rows;
}

export async function addCollaborator(
  weddingId: string,
  invitedByUserId: string,
  email: string,
  permissionLevel: "VIEW" | "COMMENT" | "EDIT"
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
    `INSERT INTO "wedding_collaborators" (id, "weddingId", "userId", "permissionLevel", "invitedByUserId")
     VALUES ($1, $2, $3, $4::"CollaboratorPermission", $5)`,
    [id, weddingId, user.id, permissionLevel, invitedByUserId]
  );

  return {
    id,
    weddingId,
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    permissionLevel,
    invitedByUserId,
    createdAt: new Date(),
  };
}

export async function updateCollaboratorPermission(
  weddingId: string,
  collaboratorId: string,
  permissionLevel: "VIEW" | "COMMENT" | "EDIT"
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE "wedding_collaborators" SET "permissionLevel" = $1::"CollaboratorPermission"
     WHERE id = $2 AND "weddingId" = $3`,
    [permissionLevel, collaboratorId, weddingId]
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
