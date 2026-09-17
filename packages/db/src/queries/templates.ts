import { randomUUID } from "crypto";
import { pool } from "../pool";
import { compareTableLabels } from "@seatwise/shared";

// TS-19 (FR-14.1/FR-14.2): a template is a reusable snapshot of a wedding's table layout plus its
// "rule-shape" (the wedding's Side-Mixing setting). It deliberately never stores anything
// guest-specific -- see the SeatingTemplate/SeatingTemplateTable model comments in schema.prisma
// for the full reasoning. A template belongs to the planner who saved it (ownerId), not to any
// one wedding, so it can seed any of that planner's weddings.

export interface SeatingTemplateTableRow {
  id: string;
  templateId: string;
  label: string;
  capacity: number;
  isRestricted: boolean;
  isAccessible: boolean;
  isLocked: boolean;
  purpose: string | null;
  purposeCriterionType: string | null;
  purposeCriterionValue: string | null;
  singleSideOnly: boolean;
  shape: string;
  positionX: number | null;
  positionY: number | null;
  sortOrder: number;
}

export interface SeatingTemplateRow {
  id: string;
  ownerId: string;
  name: string;
  sourceWeddingId: string | null;
  // FR-14.1: provenance display only -- null once the source wedding has been deleted (the
  // template itself is unaffected; sourceWeddingId goes null via ON DELETE SET NULL).
  sourceWeddingName: string | null;
  sideMixing: string;
  tableCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SeatingTemplateDetail extends SeatingTemplateRow {
  tables: SeatingTemplateTableRow[];
}

export class TemplateNotFoundError extends Error {}

const SELECT_TEMPLATE = `
  SELECT st.id, st."ownerId", st.name, st."sourceWeddingId", w.name AS "sourceWeddingName",
         st."sideMixing", st."createdAt", st."updatedAt",
         COALESCE(tc.count, 0)::int AS "tableCount"
  FROM "seating_templates" st
  LEFT JOIN "weddings" w ON w.id = st."sourceWeddingId"
  LEFT JOIN (
    SELECT "templateId", COUNT(*) AS count FROM "seating_template_tables" GROUP BY "templateId"
  ) tc ON tc."templateId" = st.id
`;

const TEMPLATE_TABLE_COLUMNS = `id, "templateId", label, capacity, "isRestricted", "isAccessible",
  "isLocked", purpose, "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape,
  "positionX", "positionY", "sortOrder"`;

// FR-14.1/FR-14.2: snapshots the wedding's current sideMixing setting and every one of its
// seating tables' structural fields (never requiredGuestIds -- see the model comment) into one
// new template, in a single transaction so a save can never land as half a template.
export async function createTemplateFromWedding(
  ownerId: string,
  weddingId: string,
  name: string
): Promise<SeatingTemplateDetail> {
  const templateId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: weddingRows } = await client.query(
      `SELECT "sideMixing" FROM "weddings" WHERE id = $1`,
      [weddingId]
    );
    const wedding = weddingRows[0];
    if (!wedding) throw new TemplateNotFoundError("Wedding not found.");

    await client.query(
      `INSERT INTO "seating_templates" (id, "ownerId", name, "sourceWeddingId", "sideMixing", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"SideMixingSetting", now())`,
      [templateId, ownerId, name, weddingId, wedding.sideMixing]
    );

    // ORDER BY here is just a stable baseline -- sorting on `label` in SQL is lexicographic
    // ("Table 10" ahead of "Table 2"), and that wrong order would get baked permanently into
    // each row's `sortOrder` below. The real ordering is applied in JS with the same
    // numeric-aware comparator used everywhere else tables are listed.
    const { rows: tableRows } = await client.query(
      `SELECT label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
              "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape,
              "positionX", "positionY"
       FROM "seating_tables" WHERE "weddingId" = $1 ORDER BY "createdAt"`,
      [weddingId]
    );
    tableRows.sort((a, b) => compareTableLabels(a.label, b.label));
    let sortOrder = 0;
    for (const t of tableRows) {
      await client.query(
        `INSERT INTO "seating_template_tables"
           (id, "templateId", label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
            "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape,
            "positionX", "positionY", "sortOrder")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::"TablePurposeCriterionType", $10, $11, $12::"TableShape", $13, $14, $15)`,
        [
          randomUUID(),
          templateId,
          t.label,
          t.capacity,
          t.isRestricted,
          t.isAccessible,
          t.isLocked,
          t.purpose,
          t.purposeCriterionType,
          t.purposeCriterionValue,
          t.singleSideOnly,
          t.shape,
          t.positionX,
          t.positionY,
          sortOrder++,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const created = await getTemplateForOwner(templateId, ownerId);
  if (!created) throw new Error("Failed to load template after creating it");
  return created;
}

export async function listTemplatesForOwner(ownerId: string): Promise<SeatingTemplateRow[]> {
  const { rows } = await pool.query(
    `${SELECT_TEMPLATE} WHERE st."ownerId" = $1 ORDER BY st."createdAt" DESC`,
    [ownerId]
  );
  return rows;
}

export async function getTemplateForOwner(id: string, ownerId: string): Promise<SeatingTemplateDetail | null> {
  const { rows } = await pool.query(`${SELECT_TEMPLATE} WHERE st.id = $1 AND st."ownerId" = $2`, [
    id,
    ownerId,
  ]);
  const template = rows[0];
  if (!template) return null;

  const { rows: tables } = await pool.query(
    `SELECT ${TEMPLATE_TABLE_COLUMNS} FROM "seating_template_tables" WHERE "templateId" = $1 ORDER BY "sortOrder"`,
    [id]
  );
  return { ...template, tables };
}

export async function deleteTemplateForOwner(id: string, ownerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM "seating_templates" WHERE id = $1 AND "ownerId" = $2`,
    [id, ownerId]
  );
  return (rowCount ?? 0) > 0;
}
