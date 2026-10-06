import { randomBytes, randomUUID } from "crypto";
import { pool, beginTransaction } from "../pool";
import { hashLinkToken } from "../link-tokens";
import { type CollaboratorRole } from "./collaborators";

// FR-1.4a: a real invite lifecycle. An invite is looked up only by its opaque token (never a
// weddingId + email pair, so a token can be handed to exactly one person without leaking which
// wedding it belongs to until it's read) and carries no guest data of its own -- only a role, a
// permission level, and who it was sent to.

// TS-177: exported, so the invite email states the real number.
export const INVITE_TTL_DAYS = 7;

export class InviteError extends Error {
  constructor(
    message: string,
    // TS-195: NOT_OWNER -- the person asking isn't the wedding's owner any more.
    public code: "NOT_FOUND" | "ALREADY_OWNER" | "ALREADY_COLLABORATOR" | "NOT_OWNER"
  ) {
    super(message);
    this.name = "InviteError";
  }
}

const NOT_OWNER_MESSAGE = "Only the wedding's owner can manage invites — and you aren't its owner any more.";

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

// TS-187: "now" in UTC, as a time without a zone -- what "expiresAt" (a column without a time zone)
// holds. Comparing or adding to it this way gives the same answer whatever the time zone of the
// server or the database session.
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;

// TS-187: an invite's columns, with "expiresAt" read back as the UTC moment it is (a time with a
// zone), so the app's own reading of it doesn't depend on the server's time zone either.
function inviteColumns(alias = ""): string {
  const a = alias ? `${alias}.` : "";
  return `${a}id, ${a}"weddingId", ${a}email, ${a}role, ${a}"permissionLevel", ${a}status, ${a}"invitedByUserId", ${a}"expiresAt" AT TIME ZONE 'UTC' AS "expiresAt", ${a}"acceptedAt", ${a}"createdAt"`;
}
const INVITE_COLUMNS = inviteColumns();

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
  if (wedding.ownerId !== invitedByUserId) throw new InviteError(NOT_OWNER_MESSAGE, "NOT_OWNER");

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

  const { rows } = await pool.query(
    // TS-187: the expiry is worked out by the database, in UTC (the column has no time zone and is
    // read as UTC). Before, it was a JavaScript date, which is sent in the server's own time zone
    // -- so on a server not set to UTC an invite lasted hours longer or shorter than 7 days.
    // TS-195: only while the person sending it still owns the wedding (it could have been handed
    // off since the check above) -- checked in the same statement that saves it.
    `INSERT INTO "wedding_invites"
       (id, "weddingId", email, role, "permissionLevel", token, status, "invitedByUserId", "expiresAt")
     SELECT $1, $2, $3, $4::"CollaboratorRole", $5::"CollaboratorPermission", $6, 'PENDING', $7,
             ${UTC_NOW} + make_interval(days => $8::int)
     WHERE EXISTS (SELECT 1 FROM "weddings" WHERE id = $2 AND "ownerId" = $7)
     RETURNING ${INVITE_COLUMNS}`,
    // TS-160: only the token's hash is stored; the token itself goes out in the email and nowhere else.
    [id, weddingId, normalizedEmail, role, permissionLevel, hashLinkToken(token), invitedByUserId, INVITE_TTL_DAYS]
  );

  if (!rows[0]) throw new InviteError(NOT_OWNER_MESSAGE, "NOT_OWNER");
  return { ...withDerivedStatus(rows[0]), token };
}

export async function listInvitesForWedding(weddingId: string): Promise<WeddingInviteRow[]> {
  const { rows } = await pool.query(
    `SELECT ${INVITE_COLUMNS}
     FROM "wedding_invites" WHERE "weddingId" = $1 ORDER BY "createdAt" DESC`,
    [weddingId]
  );
  return rows.map(withDerivedStatus);
}

// TS-195: only by the wedding's owner, checked in the same statement (it could have been handed off
// since the route's own check).
export async function revokeInvite(weddingId: string, inviteId: string, actorUserId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE "wedding_invites" SET status = 'REVOKED'
     WHERE id = $1 AND "weddingId" = $2 AND status = 'PENDING'
       AND EXISTS (SELECT 1 FROM "weddings" WHERE id = $2 AND "ownerId" = $3)`,
    [inviteId, weddingId, actorUserId]
  );
  if (!rowCount) {
    const { rows: owned } = await pool.query(`SELECT 1 FROM "weddings" WHERE id = $1 AND "ownerId" = $2`, [weddingId, actorUserId]);
    if (!owned[0]) throw new InviteError(NOT_OWNER_MESSAGE, "NOT_OWNER");
    throw new InviteError("Invite not found or already resolved.", "NOT_FOUND");
  }
}

export interface InviteLookupRow extends WeddingInviteRow {
  weddingName: string;
}

export async function getInviteByToken(token: string): Promise<InviteLookupRow | null> {
  const { rows } = await pool.query(
    `SELECT ${inviteColumns("wi")}, w.name AS "weddingName"
     FROM "wedding_invites" wi
     JOIN "weddings" w ON w.id = wi."weddingId"
     WHERE wi.token = $1`,
    [hashLinkToken(token)]
  );
  if (!rows[0]) return null;
  return withDerivedStatus(rows[0]);
}

// Accepts an invite on behalf of an already-authenticated user, whose own email must match the
// invited address (checked by the caller -- this function trusts acceptingUserEmail as already
// verified).
//
// TS-148: claiming the invite and granting access happen in one transaction, and the claim only
// succeeds while the invite is still pending and unexpired -- so an invite revoked a moment
// earlier can't still grant access. Someone who already has access keeps exactly the access they
// have (an old invite never changes it).
export async function acceptInvite(
  token: string,
  acceptingUserId: string
): Promise<{ weddingId: string } | { error: InviteStatus | "NOT_FOUND" | "ALREADY_COLLABORATOR" }> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { rows } = await client.query(
      `UPDATE "wedding_invites" SET status = 'ACCEPTED', "acceptedAt" = now()
       WHERE token = $1 AND status = 'PENDING' AND "expiresAt" > ${UTC_NOW}
       RETURNING "weddingId", role, "permissionLevel", "invitedByUserId"`,
      [hashLinkToken(token)]
    );
    const claimed = rows[0];
    if (!claimed) {
      await client.query("ROLLBACK").catch(() => {});
      const invite = await getInviteByToken(token);
      return { error: invite ? invite.status : "NOT_FOUND" };
    }
    const { rowCount } = await client.query(
      `INSERT INTO "wedding_collaborators" (id, "weddingId", "userId", "role", "permissionLevel", "invitedByUserId")
       VALUES ($1, $2, $3, $4::"CollaboratorRole", $5::"CollaboratorPermission", $6)
       ON CONFLICT ("weddingId", "userId") DO NOTHING`,
      [randomUUID(), claimed.weddingId, acceptingUserId, claimed.role, claimed.permissionLevel, claimed.invitedByUserId]
    );
    if (!rowCount) {
      await client.query("ROLLBACK").catch(() => {});
      return { error: "ALREADY_COLLABORATOR" };
    }
    await client.query("COMMIT");
    return { weddingId: claimed.weddingId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
