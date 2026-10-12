import { pool, beginTransaction } from "../pool";
import { newLinkToken } from "../link-tokens";
import { lockWeddingRow } from "./wedding-lock";

export interface ResetLinksResult {
  guestLinks: number;
  vendorLinks: number;
}

// TS-195: the person asking is no longer this wedding's owner (it was handed off a moment ago).
export class LinkResetNotOwnerError extends Error {
  constructor() {
    super("Only the wedding's owner can reset its links — and you aren't its owner any more.");
  }
}

// TS-209: a reset that lost a race with another change (the database broke a deadlock) -- it said
// "Someone else changed this plan", which isn't what the owner was doing. Nothing was reset.
export const LINK_RESET_CONFLICT_MESSAGE =
  "Someone was changing the guest list or seating at the same moment, so no links were reset. Please try again.";

// TS-179: the owner's "Reset all guest and vendor links". Every guest RSVP link and vendor share
// link the wedding has handed out gets a brand-new token (the same new hash + encrypted copy the
// single-link "regenerate" uses), so every old link stops working -- e.g. after removing a
// collaborator who may have copied some. Guests and vendors who never had a link are left alone
// (there is nothing out there to stop). One transaction, so it's all or nothing. No emails are
// sent: the planner shares the new links themselves.
// TS-195: the wedding's lock first (and its owner checked under it -- a hand-off a moment ago means
// this person can't reset its links any more), then the guests and vendors in a fixed order
// (ORDER BY id), so two resets, or a reset and another change, take their locks the same way
// round. FOR UPDATE again, not NO KEY UPDATE: the link columns are unique, so rewriting them is
// a change to a key, which Postgres only allows under a full row lock -- with the weaker lock it
// had to upgrade it mid-way, which could deadlock with a seat being saved for the same guest.
export async function resetWeddingLinkTokens(weddingId: string, actorUserId: string): Promise<ResetLinksResult> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { ownerId } = await lockWeddingRow(client, weddingId);
    if (ownerId !== actorUserId) throw new LinkResetNotOwnerError();
    const { rows: guests } = await client.query(
      `SELECT id FROM "guests" WHERE "weddingId" = $1 AND ("rsvpTokenHash" IS NOT NULL OR "rsvpToken" IS NOT NULL)
       ORDER BY id FOR UPDATE`,
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
      `SELECT id FROM "vendors" WHERE "weddingId" = $1 AND ("shareTokenHash" IS NOT NULL OR "shareToken" IS NOT NULL)
       ORDER BY id FOR UPDATE`,
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
