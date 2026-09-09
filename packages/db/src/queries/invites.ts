import { randomBytes, randomUUID } from "crypto";
import { pool } from "../pool";
import { upsertCollaboratorByUserId, type CollaboratorRole } from "./collaborators";

// FR-1.4a: a real invite lifecycle. An invite is looked up only by its opaque token (never a
// weddingId + email pair, so a token can be handed to exactly one person without leaking which
// wedding it belongs to until it's read) and carries no guest data of its own -- only a role, a
// permission level, and who it was sent to.

const INVITE_TTL_DAYS = 7;

export class InviteError extends Error {
  constructor(
    message: string,
    public code: "NOT_FOUND" | "ALREADY_OWNER" | "ALREADY_COLLABORATOR"
  ) {
    super(message);
    this.name = "InviteError";
  }
}

export type InviteStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

export interface WeddingInviteRow {
  id: string;
  weddingId: string;
  email: string;
  role: CollaboratorRole;
  permissionLevel: "VIEW" | "COMMENT" | "EDIT";
  status: InviteStatus;
  invitedByUserId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

// "Expired" is derived from expiresAt rather than its own stored transition -- nobody performs an
// action to make an invite expire, time just passes -- but a row whose status is still the stored
// PENDING and whose expiresAt has passed reports (and behaves) as EXPIRED everywhere it's read.
function withDerivedStatus<T extends { status: string; expiresAt: Date }>(row: T): T {
  if (row.status === "PENDING" && row.expiresAt.getTime() < Date.now()) {
    return { ...row, status: "EXPIRED" };
  }
  return row;
}

export async function createInvite(
  weddingId: string,
  invitedByUserId: string,
  email: string,
  permissionLevel: "VIEW" | "COMMENT" | "EDIT",
  role: CollaboratorRole
): Promise<WeddingInviteRow & { token: string }> {
  const normalizedEmail = email.trim().toLowerCase();

  const { rows: weddingRows } = await pool.query(`SELECT "ownerId" FROM "weddings" WHERE id = $1`, [
    weddingId,
  ]);
  const wedding = weddingRows[0];
  if (!wedding) {
    throw new InviteError("Wedding not found.", "NOT_FOUND");
  }

  const { rows: ownerRows } = await pool.query(`SELECT id, email FROM "users" WHERE id = $1`, [
    wedding.ownerId,
  ]);
  if (ownerRows[0]?.email?.toLowerCase() === normalizedEmail) {
    throw new InviteError("That person already owns this wedding.", "ALREADY_OWNER");
  }

  const { rows: existingCollabRows } = await pool.query(
    `SELECT wc.id FROM "wedding_collaborators" wc
     JOIN "users" u ON u.id = wc."userId"
     WHERE wc."weddingId" = $1 AND lower(u.email) = $2`,
    [weddingId, normalizedEmail]
  );
  if (existingCollabRows[0]) {
    throw new InviteError("That person is already a collaborator on this wedding.", "ALREADY_COLLABORATOR");
  }

  // Re-inviting the same address supersedes any invite already pending for it, so there's never
  // more than one active invite (and one live token) per email per wedding.
  await pool.query(
    `UPDATE "wedding_invites" SET status = 'REVOKED'
     WHERE "weddingId" = $1 AND lower(email) = $2 AND status = 'PENDING'`,
    [weddingId, normalizedEmail]
  );

  const id = randomUUID();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const { rows } = await pool.query(
    `INSERT INTO "wedding_invites"
       (id, "weddingId", email, role, "permissionLevel", token, status, "invitedByUserId", "expiresAt")
     VALUES ($1, $2, $3, $4::"CollaboratorRole", $5::"CollaboratorPermission", $6, 'PENDING', $7, $8)
     RETURNING id, "weddingId", email, role, "permissionLevel", status, "invitedByUserId", "expiresAt", "acceptedAt", "createdAt"`,
    [id, weddingId, normalizedEmail, role, permissionLevel, token, invitedByUserId, expiresAt]
  );

  return { ...withDerivedStatus(rows[0]), token };
}

export async function listInvitesForWedding(weddingId: string): Promise<WeddingInviteRow[]> {
  const { rows } = await pool.query(
    `SELECT id, "weddingId", email, role, "permissionLevel", status, "invitedByUserId", "expiresAt", "acceptedAt", "createdAt"
     FROM "wedding_invites" WHERE "weddingId" = $1 ORDER BY "createdAt" DESC`,
    [weddingId]
  );
  return rows.map(withDerivedStatus);
}

export async function revokeInvite(weddingId: string, inviteId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE "wedding_invites" SET status = 'REVOKED'
     WHERE id = $1 AND "weddingId" = $2 AND status = 'PENDING'`,
    [inviteId, weddingId]
  );
  if (!rowCount) {
    throw new InviteError("Invite not found or already resolved.", "NOT_FOUND");
  }
}

export interface InviteLookupRow extends WeddingInviteRow {
  weddingName: string;
}

export async function getInviteByToken(token: string): Promise<InviteLookupRow | null> {
  const { rows } = await pool.query(
    `SELECT wi.id, wi."weddingId", wi.email, wi.role, wi."permissionLevel", wi.status,
            wi."invitedByUserId", wi."expiresAt", wi."acceptedAt", wi."createdAt", w.name AS "weddingName"
     FROM "wedding_invites" wi
     JOIN "weddings" w ON w.id = wi."weddingId"
     WHERE wi.token = $1`,
    [token]
  );
  if (!rows[0]) return null;
  return withDerivedStatus(rows[0]);
}

// Accepts an invite on behalf of an already-authenticated user, whose own email must match the
// invited address (checked by the caller -- this function trusts acceptingUserEmail as already
// verified). Grants access via the same upsert the direct-add flow uses, so re-accepting (or
// accepting after a prior direct add) updates role/permission rather than erroring.
export async function acceptInvite(
  token: string,
  acceptingUserId: string
): Promise<{ weddingId: string } | { error: InviteStatus | "NOT_FOUND" }> {
  const invite = await getInviteByToken(token);
  if (!invite) return { error: "NOT_FOUND" };
  if (invite.status !== "PENDING") return { error: invite.status };

  await upsertCollaboratorByUserId(
    invite.weddingId,
    acceptingUserId,
    invite.permissionLevel,
    invite.role,
    invite.invitedByUserId
  );

  await pool.query(
    `UPDATE "wedding_invites" SET status = 'ACCEPTED', "acceptedAt" = now() WHERE id = $1`,
    [invite.id]
  );

  return { weddingId: invite.weddingId };
}
