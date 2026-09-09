import { randomUUID } from "crypto";
import { pool } from "../pool";

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
  "contactPhone", "costCents", "contractNotes", revision, "createdAt", "updatedAt"`;

export async function createVendor(weddingId: string, input: CreateVendorData): Promise<VendorRow> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO "vendors"
       (id, "weddingId", name, category, "categoryOther", "contactName", "contactEmail",
        "contactPhone", "costCents", "contractNotes", "updatedAt")
     VALUES ($1, $2, $3, $4::"VendorCategory", $5, $6, $7, $8, $9, $10, now())
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
}

// FR-15.2: budgetCents lives on the wedding itself; totalCostCents sums every vendor's costCents
// (nulls treated as 0, via COALESCE inside the SUM rather than after it); remainingCents is only
// meaningful once a budget is actually set -- null budgetCents means there's nothing to compare
// the total against yet, so remainingCents comes back null too rather than a bare negative total.
export async function getBudgetSummaryForWedding(weddingId: string): Promise<BudgetSummaryRow> {
  const { rows } = await pool.query(
    `SELECT w."budgetCents",
            COALESCE((SELECT SUM(COALESCE(v."costCents", 0)) FROM "vendors" v WHERE v."weddingId" = w.id), 0)::int
              AS "totalCostCents"
     FROM "weddings" w WHERE w.id = $1`,
    [weddingId]
  );
  const row = rows[0];
  if (!row) return { budgetCents: null, totalCostCents: 0, remainingCents: null };
  return {
    budgetCents: row.budgetCents,
    totalCostCents: row.totalCostCents,
    remainingCents: row.budgetCents === null ? null : row.budgetCents - row.totalCostCents,
  };
}

export async function setBudgetForWedding(weddingId: string, budgetCents: number | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE "weddings" SET "budgetCents" = $1, "updatedAt" = now() WHERE id = $2`,
    [budgetCents, weddingId]
  );
  return (rowCount ?? 0) > 0;
}
