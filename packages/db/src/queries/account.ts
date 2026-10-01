import { randomUUID } from "crypto";
import { pool } from "../pool";

// TS-105 (Tom's decision, 2026-10-01): a planner can delete their account only once every wedding
// they own has been handed off -- so no wedding is ever left with nobody in charge. Handing off
// makes one of the wedding's collaborators its owner; the previous owner stays on with Edit access
// and can leave afterwards.

export class OwnershipTransferError extends Error {}

export interface OwnedWeddingRow {
  id: string;
  name: string;
}

export async function listWeddingsOwnedBy(userId: string): Promise<OwnedWeddingRow[]> {
  const { rows } = await pool.query<OwnedWeddingRow>(
    `SELECT id, name FROM "weddings" WHERE "ownerId" = $1 ORDER BY name`,
    [userId]
  );
  return rows;
}

/** Makes collaborator `collaboratorId` the owner of `weddingId`; the old owner becomes an Edit collaborator. */
export async function transferWeddingOwnership(
  weddingId: string,
  currentOwnerId: string,
  collaboratorId: string
): Promise<{ newOwnerUserId: string; newOwnerName: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: weddingRows } = await client.query(
      `SELECT "ownerId" FROM "weddings" WHERE id = $1 FOR UPDATE`,
      [weddingId]
    );
    if (!weddingRows[0] || weddingRows[0].ownerId !== currentOwnerId) {
      throw new OwnershipTransferError("Only the wedding's owner can hand it off.");
    }
    const { rows: collabRows } = await client.query(
      `SELECT wc."userId", u.name FROM "wedding_collaborators" wc JOIN "users" u ON u.id = wc."userId"
       WHERE wc.id = $1 AND wc."weddingId" = $2 FOR UPDATE OF wc`,
      [collaboratorId, weddingId]
    );
    const target = collabRows[0] as { userId: string; name: string } | undefined;
    if (!target) throw new OwnershipTransferError("Pick someone who already has access to this wedding.");

    await client.query(`DELETE FROM "wedding_collaborators" WHERE id = $1`, [collaboratorId]);
    await client.query(`UPDATE "weddings" SET "ownerId" = $1, "updatedAt" = now() WHERE id = $2`, [
      target.userId,
      weddingId,
    ]);
    await client.query(
      `INSERT INTO "wedding_collaborators" (id, "weddingId", "userId", role, "permissionLevel", "invitedByUserId")
       VALUES ($1, $2, $3, 'COLLABORATOR', 'EDIT', $4)`,
      [randomUUID(), weddingId, currentOwnerId, target.userId]
    );
    await client.query("COMMIT");
    return { newOwnerUserId: target.userId, newOwnerName: target.name };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deletes the account. Refuses (returning the weddings) while it still owns any. Its access to
 * other weddings, notifications and saved templates go with it; comments it wrote stay, shown as
 * "Former member".
 */
export async function deleteUserAccount(
  userId: string
): Promise<{ deleted: true } | { deleted: false; ownedWeddings: OwnedWeddingRow[] }> {
  const owned = await listWeddingsOwnedBy(userId);
  if (owned.length > 0) return { deleted: false, ownedWeddings: owned };
  await pool.query(`DELETE FROM "users" WHERE id = $1`, [userId]);
  return { deleted: true };
}
