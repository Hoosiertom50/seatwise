import { pool, beginTransaction } from "../pool";
import { newLinkToken } from "../link-tokens";

export interface ResetLinksResult {
  guestLinks: number;
  vendorLinks: number;
}

// TS-179: the owner's "Reset all guest and vendor links". Every guest RSVP link and vendor share
// link the wedding has handed out gets a brand-new token (the same new hash + encrypted copy the
// single-link "regenerate" uses), so every old link stops working -- e.g. after removing a
// collaborator who may have copied some. Guests and vendors who never had a link are left alone
// (there is nothing out there to stop). One transaction, so it's all or nothing. No emails are
// sent: the planner shares the new links themselves.
export async function resetWeddingLinkTokens(weddingId: string): Promise<ResetLinksResult> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { rows: guests } = await client.query(
      `SELECT id FROM "guests" WHERE "weddingId" = $1 AND ("rsvpTokenHash" IS NOT NULL OR "rsvpToken" IS NOT NULL) FOR NO KEY UPDATE`,
      [weddingId]
    );
    for (const g of guests) {
      const fresh = newLinkToken();
      await client.query(`UPDATE "guests" SET "rsvpToken" = $1, "rsvpTokenHash" = $2 WHERE id = $3`, [
        fresh.encrypted,
        fresh.hash,
        g.id,
      ]);
    }
    const { rows: vendors } = await client.query(
      `SELECT id FROM "vendors" WHERE "weddingId" = $1 AND ("shareTokenHash" IS NOT NULL OR "shareToken" IS NOT NULL) FOR NO KEY UPDATE`,
      [weddingId]
    );
    for (const v of vendors) {
      const fresh = newLinkToken();
      await client.query(`UPDATE "vendors" SET "shareToken" = $1, "shareTokenHash" = $2 WHERE id = $3`, [
        fresh.encrypted,
        fresh.hash,
        v.id,
      ]);
    }
    await client.query("COMMIT");
    return { guestLinks: guests.length, vendorLinks: vendors.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
