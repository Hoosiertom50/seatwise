import { randomUUID } from "crypto";
import { pool, beginTransaction } from "../pool";

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
    await beginTransaction(client);
    // TS-187: NO KEY UPDATE, like every other wedding lock (TS-185) -- a full FOR UPDATE here also
    // held up every change elsewhere in the wedding that Postgres checks the wedding exists for.
    const { rows: weddingRows } = await client.query(
      `SELECT "ownerId" FROM "weddings" WHERE id = $1 FOR NO KEY UPDATE`,
      [weddingId]
    );
    if (!weddingRows[0] || weddingRows[0].ownerId !== currentOwnerId) {
      throw new OwnershipTransferError("Only the wedding's owner can hand it off.");
    }
    // TS-195: the new owner's account row next (FOR KEY SHARE: "it must stay there"), before their
    // access row is touched. Before, the hand-off locked and deleted their access row first and only
    // reached their account when it made them the owner -- while their account delete, which had
    // already locked the account, waited to delete that same access row: each waiting for the
    // other (reproduced; Postgres broke it with an error, a 500). Now whichever comes second waits
    // for the first to finish: a delete that came first leaves no account here (refused below,
    // nothing changed); a hand-off that came first makes the delete see the wedding it now owns.
    const { rows: who } = await client.query<{ userId: string }>(
      `SELECT "userId" FROM "wedding_collaborators" WHERE id = $1 AND "weddingId" = $2`,
      [collaboratorId, weddingId]
    );
    if (!who[0]) throw new OwnershipTransferError("Pick someone who already has access to this wedding.");
    const { rows: account } = await client.query(`SELECT id FROM "users" WHERE id = $1 FOR KEY SHARE`, [who[0].userId]);
    if (!account[0]) {
      throw new OwnershipTransferError("That person's account was just deleted — pick someone else to hand this wedding to.");
    }
    const { rows: collabRows } = await client.query(
      `SELECT wc."userId", u.name, wc."emailNotificationsEnabled" FROM "wedding_collaborators" wc JOIN "users" u ON u.id = wc."userId"
       WHERE wc.id = $1 AND wc."weddingId" = $2 FOR UPDATE OF wc`,
      [collaboratorId, weddingId]
    );
    const target = collabRows[0] as { userId: string; name: string; emailNotificationsEnabled: boolean } | undefined;
    // Their access was removed (or given to someone else's row) while this waited -- checked again.
    if (!target || target.userId !== who[0].userId) {
      throw new OwnershipTransferError("Pick someone who already has access to this wedding.");
    }

    await client.query(`DELETE FROM "wedding_collaborators" WHERE id = $1`, [collaboratorId]);
    // TS-213: each person's own "Email me about this wedding" switch goes with them -- the new
    // owner's from their access row to the wedding, the old owner's from the wedding to their new
    // access row.
    const { rows: previous } = await client.query<{ ownerEmails: boolean }>(
      `UPDATE "weddings" w SET "ownerId" = $1, "updatedAt" = now(), "ownerEmailNotificationsEnabled" = $3
         FROM (SELECT "ownerEmailNotificationsEnabled" AS "ownerEmails" FROM "weddings" WHERE id = $2) old
       WHERE w.id = $2 RETURNING old."ownerEmails"`,
      [target.userId, weddingId, target.emailNotificationsEnabled]
    );
    await client.query(
      `INSERT INTO "wedding_collaborators" (id, "weddingId", "userId", role, "permissionLevel", "invitedByUserId", "emailNotificationsEnabled")
       VALUES ($1, $2, $3, 'COLLABORATOR', 'EDIT', $4, $5)`,
      [randomUUID(), weddingId, currentOwnerId, target.userId, previous[0]?.ownerEmails ?? true]
    );
    await client.query("COMMIT");
    return { newOwnerUserId: target.userId, newOwnerName: target.name };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // TS-187: the person it was being handed to deleted their account at that same moment -- the
    // database refused to make a deleted account the owner. Nothing changed.
    const code = (err as { code?: string }).code;
    if (code === "23503") {
      throw new OwnershipTransferError("That person's account was just deleted — pick someone else to hand this wedding to.");
    }
    // TS-195: lost a race with another change to this wedding's access (Postgres broke a deadlock,
    // or asked for a retry) -- in words about the hand-off, not "the plan changed". Nothing changed.
    if (code === "40P01" || code === "40001") {
      throw new OwnershipTransferError("Someone changed who has access to this wedding at the same moment — it wasn't handed off. Please try again.");
    }
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
): Promise<
  | { deleted: true }
  | { deleted: false; ownedWeddings: OwnedWeddingRow[] }
  // TS-195: it ran into another change at the same moment (nothing was deleted) -- try again.
  | { deleted: false; tryAgain: true }
> {
  const owned = await listWeddingsOwnedBy(userId);
  if (owned.length > 0) return { deleted: false, ownedWeddings: owned };
  // TS-187: a wedding being handed to this person at this very moment used to be deleted along
  // with the account (reproduced): the delete's "owns nothing" check couldn't see the hand-off,
  // which wasn't saved yet, and went ahead once it was. Now, in one transaction:
  //   1. the account's row is locked -- this waits for a hand-off to it that's under way to finish
  //      (and a hand-off that starts later waits for this, then finds the account gone);
  //   2. what it owns is read again, in a new statement, which sees that finished hand-off;
  //   3. only then is it deleted.
  // And the database itself refuses to delete an account that owns a wedding (ON DELETE RESTRICT,
  // migration 20261006180000_wedding_owner_restrict) -- answered the same way if it ever does.
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { rows: me } = await client.query(`SELECT id FROM "users" WHERE id = $1 FOR UPDATE`, [userId]);
    if (!me[0]) {
      // Already gone (deleted from another tab a moment ago) -- nothing left to delete.
      await client.query("ROLLBACK").catch(() => {});
      return { deleted: true };
    }
    const { rows: stillOwned } = await client.query<OwnedWeddingRow>(
      `SELECT id, name FROM "weddings" WHERE "ownerId" = $1 ORDER BY name`,
      [userId]
    );
    if (stillOwned.length > 0) {
      await client.query("ROLLBACK").catch(() => {});
      return { deleted: false, ownedWeddings: stillOwned };
    }
    await client.query(`DELETE FROM "users" WHERE id = $1`, [userId]);
    await client.query("COMMIT");
    return { deleted: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const code = (err as { code?: string }).code;
    // TS-195: Postgres broke a deadlock with another change (a hand-off, say), or asked for a
    // retry -- nothing was deleted. Answered as "try again", not a server error.
    if (code === "40P01" || code === "40001") return { deleted: false, tryAgain: true };
    if (code === "23503") {
      return { deleted: false, ownedWeddings: await listWeddingsOwnedBy(userId) };
    }
    throw err;
  } finally {
    client.release();
  }
}
