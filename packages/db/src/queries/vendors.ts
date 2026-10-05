import { randomUUID } from "crypto";
import { pool } from "../pool";
import { encryptText } from "../crypto";
import { hashLinkToken, isPlainStoredLinkToken, newLinkToken, readStoredLinkToken } from "../link-tokens";

// TS-20 (FR-15.1/FR-15.2): a per-wedding vendor record, plus the wedding-wide budget figure it's
// tracked against. Money is always integer cents (never a float) -- see the Vendor model comment
// in schema.prisma for why.

export interface VendorRow {
  id: string;
  weddingId: string;
  name: string;
  category: string;
  categoryOther: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  costCents: number | null;
  contractNotes: string | null;
  // TS-114
  arrivalTime: string | null;
  shareLinkActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  // FR-7.7: an optimistic-concurrency counter -- an edit that names an expectedRevision the
  // server no longer matches is rejected as stale.
  revision: number;
}

export interface CreateVendorData {
  name: string;
  category: string;
  categoryOther?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  costCents?: number | null;
  contractNotes?: string | null;
  arrivalTime?: string | null;
}

// FR-7.7, extended to vendors: thrown instead of applying an edit whose expectedRevision no
// longer matches the vendor's current one -- the fresh, currently-committed vendor is attached so
// the caller can refresh the UI with it directly rather than making a second round-trip.
export class VendorConflictError extends Error {
  vendor: VendorRow;
  constructor(message: string, vendor: VendorRow) {
    super(message);
    this.vendor = vendor;
  }
}

const COLUMNS = `id, "weddingId", name, category, "categoryOther", "contactName", "contactEmail",
  "contactPhone", "costCents", "contractNotes", "arrivalTime", ("shareToken" IS NOT NULL) AS "shareLinkActive",
  revision, "createdAt", "updatedAt"`;

export async function createVendor(weddingId: string, input: CreateVendorData): Promise<VendorRow> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO "vendors"
       (id, "weddingId", name, category, "categoryOther", "contactName", "contactEmail",
        "contactPhone", "costCents", "contractNotes", "arrivalTime", "updatedAt")
     VALUES ($1, $2, $3, $4::"VendorCategory", $5, $6, $7, $8, $9, $10, $11, now())
     RETURNING ${COLUMNS}`,
    [
      id,
      weddingId,
      input.name,
      input.category,
      input.categoryOther ?? null,
      input.contactName ?? null,
      input.contactEmail ?? null,
      input.contactPhone ?? null,
      input.costCents ?? null,
      input.contractNotes ?? null,
      input.arrivalTime ?? null,
    ]
  );
  return rows[0];
}

export async function listVendorsForWedding(weddingId: string): Promise<VendorRow[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM "vendors" WHERE "weddingId" = $1 ORDER BY name`,
    [weddingId]
  );
  return rows;
}

export async function getVendorForWedding(id: string, weddingId: string): Promise<VendorRow | null> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM "vendors" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return rows[0] ?? null;
}

// FR-7.7, extended to vendors: same locked-row/compare-revision pattern as
// updateSeatingTableForWedding in tables.ts -- see that function's own comment for the full
// reasoning. A caller that passes no expectedRevision skips the check entirely.
export async function updateVendorForWedding(
  id: string,
  weddingId: string,
  input: Partial<CreateVendorData>,
  expectedRevision?: number
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (input.name !== undefined) {
    fields.push(`name = $${i++}`);
    values.push(input.name);
  }
  if (input.category !== undefined) {
    fields.push(`category = $${i++}::"VendorCategory"`);
    values.push(input.category);
  }
  if (input.categoryOther !== undefined) {
    fields.push(`"categoryOther" = $${i++}`);
    values.push(input.categoryOther);
  }
  if (input.contactName !== undefined) {
    fields.push(`"contactName" = $${i++}`);
    values.push(input.contactName);
  }
  if (input.contactEmail !== undefined) {
    fields.push(`"contactEmail" = $${i++}`);
    values.push(input.contactEmail);
  }
  if (input.contactPhone !== undefined) {
    fields.push(`"contactPhone" = $${i++}`);
    values.push(input.contactPhone);
  }
  if (input.costCents !== undefined) {
    fields.push(`"costCents" = $${i++}`);
    values.push(input.costCents);
  }
  if (input.contractNotes !== undefined) {
    fields.push(`"contractNotes" = $${i++}`);
    values.push(input.contractNotes);
  }
  if (input.arrivalTime !== undefined) {
    fields.push(`"arrivalTime" = $${i++}`);
    values.push(input.arrivalTime);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT revision FROM "vendors" WHERE id = $1 AND "weddingId" = $2 FOR UPDATE`,
      [id, weddingId]
    );
    const current = rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return false;
    }
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      const fresh = await getVendorForWedding(id, weddingId);
      throw new VendorConflictError(
        "This vendor changed since you loaded it — someone else's edit landed first. It's been refreshed with the latest — please try again.",
        fresh!
      );
    }
    if (fields.length > 0) {
      fields.push(`"updatedAt" = now()`, `revision = revision + 1`);
      values.push(id, weddingId);
      await client.query(
        `UPDATE "vendors" SET ${fields.join(", ")} WHERE id = $${i++} AND "weddingId" = $${i}`,
        values
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteVendorForWedding(id: string, weddingId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM "vendors" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return (rowCount ?? 0) > 0;
}

export interface BudgetSummaryRow {
  budgetCents: number | null;
  totalCostCents: number;
  remainingCents: number | null;
  budgetRevision: number;
}

// TS-92: thrown instead of applying a budget change based on a stale budgetRevision.
export class BudgetConflictError extends Error {
  constructor() {
    super("Someone else changed the budget figure after you opened it — showing the latest. Your change wasn't saved; enter it again if it's still needed.");
  }
}

// FR-15.2: budgetCents lives on the wedding itself; totalCostCents sums every vendor's costCents
// (nulls treated as 0, via COALESCE inside the SUM rather than after it); remainingCents is only
// meaningful once a budget is actually set -- null budgetCents means there's nothing to compare
// the total against yet, so remainingCents comes back null too rather than a bare negative total.
export async function getBudgetSummaryForWedding(weddingId: string): Promise<BudgetSummaryRow> {
  const { rows } = await pool.query(
    `SELECT w."budgetCents", w."budgetRevision",
            -- TS-153: bigint -- many large vendor costs overflow a 32-bit int (a 500).
            COALESCE((SELECT SUM(COALESCE(v."costCents", 0)) FROM "vendors" v WHERE v."weddingId" = w.id), 0)::bigint
              AS "totalCostCents"
     FROM "weddings" w WHERE w.id = $1`,
    [weddingId]
  );
  const row = rows[0];
  if (!row) return { budgetCents: null, totalCostCents: 0, remainingCents: null, budgetRevision: 0 };
  return {
    budgetRevision: row.budgetRevision,
    budgetCents: row.budgetCents,
    // pg returns bigint as text; a wedding's total is far below 2^53, so a JS number is exact.
    totalCostCents: Number(row.totalCostCents),
    remainingCents: row.budgetCents === null ? null : row.budgetCents - Number(row.totalCostCents),
  };
}

export async function setBudgetForWedding(
  weddingId: string,
  budgetCents: number | null,
  expectedRevision?: number
): Promise<boolean> {
  // TS-92: a single conditional UPDATE is the whole check -- it only matches the row if the
  // revision is still the one the caller saw, so nothing can slip in between check and write.
  const { rowCount } = await pool.query(
    expectedRevision === undefined
      ? `UPDATE "weddings" SET "budgetCents" = $1, "budgetRevision" = "budgetRevision" + 1, "updatedAt" = now() WHERE id = $2`
      : `UPDATE "weddings" SET "budgetCents" = $1, "budgetRevision" = "budgetRevision" + 1, "updatedAt" = now()
         WHERE id = $2 AND "budgetRevision" = $3`,
    expectedRevision === undefined ? [budgetCents, weddingId] : [budgetCents, weddingId, expectedRevision]
  );
  if ((rowCount ?? 0) === 0 && expectedRevision !== undefined) {
    const { rows } = await pool.query(`SELECT 1 FROM "weddings" WHERE id = $1`, [weddingId]);
    if (rows[0]) throw new BudgetConflictError();
  }
  return (rowCount ?? 0) > 0;
}

// TS-114: a vendor's private read-only link. Same shape as a guest's RSVP link (guests.ts):
// 32 random bytes, kept only on the row and handed out only by the share-link endpoint.
export async function ensureVendorShareToken(id: string, weddingId: string): Promise<string | null> {
  // TS-153: one statement, so two requests at once both get the same link (before, each could
  // write its own and the first link handed out would stop working).
  // TS-160: looked up by its hash; the encrypted copy is what lets this show the same link again.
  const fresh = newLinkToken();
  const { rows } = await pool.query(
    `UPDATE "vendors" SET "shareToken" = COALESCE("shareToken", $3), "shareTokenHash" = COALESCE("shareTokenHash", $4)
     WHERE id = $1 AND "weddingId" = $2
     RETURNING "shareToken"`,
    [id, weddingId, fresh.encrypted, fresh.hash]
  );
  const stored: string | null = rows[0]?.shareToken ?? null;
  if (stored && isPlainStoredLinkToken(stored)) {
    // A link made before TS-160: keep it working, but stop storing it in plain text.
    await pool.query(`UPDATE "vendors" SET "shareToken" = $1 WHERE id = $2 AND "shareToken" = $3`, [
      encryptText(stored),
      id,
      stored,
    ]);
  }
  return readStoredLinkToken(stored);
}

/** A brand-new token -- the previous link (if any) stops working at once. */
export async function regenerateVendorShareToken(id: string, weddingId: string): Promise<string | null> {
  const fresh = newLinkToken();
  const { rowCount } = await pool.query(
    `UPDATE "vendors" SET "shareToken" = $1, "shareTokenHash" = $2 WHERE id = $3 AND "weddingId" = $4`,
    [fresh.encrypted, fresh.hash, id, weddingId]
  );
  return (rowCount ?? 0) > 0 ? fresh.token : null;
}

/** Turns the link off. Returns false if there's no such vendor. */
export async function revokeVendorShareToken(id: string, weddingId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE "vendors" SET "shareToken" = NULL, "shareTokenHash" = NULL WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return (rowCount ?? 0) > 0;
}

export interface VendorViewRow {
  wedding: { name: string; eventDate: string | null; venueName: string | null };
  vendor: {
    name: string;
    category: string;
    categoryOther: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    arrivalTime: string | null;
  };
  otherVendors: { name: string; category: string; categoryOther: string | null; arrivalTime: string | null }[];
  timeline: { time: string; description: string }[];
}

// TS-114: everything the vendor's read-only page shows, and nothing else. Selected column by
// column on purpose -- costs, contract notes, budget, other vendors' contact details and every
// guest field are never read here, so they can't leak into the page or its API response.
export async function getVendorViewByToken(token: string): Promise<VendorViewRow | null> {
  const { rows } = await pool.query(
    `SELECT v.id, v."weddingId", v.name, v.category, v."categoryOther", v."contactName", v."contactEmail",
            v."contactPhone", v."arrivalTime", w.name AS "weddingName", w."eventDate"::text AS "eventDate",
            w."venueName"
     FROM "vendors" v JOIN "weddings" w ON w.id = v."weddingId"
     WHERE v."shareTokenHash" = $1`,
    [hashLinkToken(token)]
  );
  const v = rows[0];
  if (!v) return null;
  const [{ rows: others }, { rows: timeline }] = await Promise.all([
    pool.query(
      `SELECT name, category, "categoryOther", "arrivalTime" FROM "vendors"
       WHERE "weddingId" = $1 AND id <> $2
       ORDER BY "arrivalTime" NULLS LAST, name`,
      [v.weddingId, v.id]
    ),
    pool.query(
      `SELECT time, description FROM "timeline_entries" WHERE "weddingId" = $1 ORDER BY time, "sortOrder"`,
      [v.weddingId]
    ),
  ]);
  return {
    wedding: { name: v.weddingName, eventDate: v.eventDate, venueName: v.venueName },
    vendor: {
      name: v.name,
      category: v.category,
      categoryOther: v.categoryOther,
      contactName: v.contactName,
      contactEmail: v.contactEmail,
      contactPhone: v.contactPhone,
      arrivalTime: v.arrivalTime,
    },
    otherVendors: others,
    timeline,
  };
}

export interface VendorSuggestionRow {
  name: string;
  category: string;
  categoryOther: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

// TS-97: vendors from the planner's other weddings, offered as suggestions in "Add a vendor"
// (Tom's decisions, 2026-10-01). Only weddings the planner OWNS -- never ones they only
// collaborate on, so other planners' contacts aren't exposed. One suggestion per vendor name
// (case- and space-insensitive), taken from the most recently updated copy. Cost, contract notes
// and arrival time are per wedding, so they're never read here.
export async function listVendorSuggestionsForOwner(
  ownerId: string,
  excludeWeddingId: string | null
): Promise<VendorSuggestionRow[]> {
  const { rows } = await pool.query(
    `SELECT name, category, "categoryOther", "contactName", "contactEmail", "contactPhone" FROM (
       SELECT DISTINCT ON (lower(btrim(v.name)))
              btrim(v.name) AS name, v.category, v."categoryOther", v."contactName", v."contactEmail", v."contactPhone"
       FROM "vendors" v JOIN "weddings" w ON w.id = v."weddingId"
       WHERE w."ownerId" = $1 AND ($2::text IS NULL OR v."weddingId" <> $2)
       ORDER BY lower(btrim(v.name)), v."updatedAt" DESC
     ) s
     ORDER BY lower(name)`,
    [ownerId, excludeWeddingId]
  );
  return rows;
}
