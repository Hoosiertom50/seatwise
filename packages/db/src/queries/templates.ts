import { randomUUID } from "crypto";
import { pool, beginTransaction } from "../pool";
import { compareTableLabels, cutToLimit } from "@seatwise/shared";
import { lockWeddingRow } from "./wedding-lock";

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
  SELECT st.id, st."ownerId", st.name, w.id AS "sourceWeddingId", w.name AS "sourceWeddingName",
         st."sideMixing", st."createdAt", st."updatedAt",
         COALESCE(tc.count, 0)::int AS "tableCount"
  FROM "seating_templates" st
  -- TS-172: the wedding a template came from is shown only while the template's owner can still
  -- open that wedding (owner or collaborator). An Edit collaborator who saved a template and was
  -- later removed used to keep seeing the wedding's current name.
  LEFT JOIN "weddings" w ON w.id = st."sourceWeddingId"
    AND (w."ownerId" = st."ownerId"
      OR EXISTS (SELECT 1 FROM "wedding_collaborators" wc WHERE wc."weddingId" = w.id AND wc."userId" = st."ownerId"))
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
    await beginTransaction(client);

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
    await client.query("ROLLBACK").catch(() => {});
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

// TS-91: the table columns a layout carries -- shared by applying a template to an existing
// wedding and by duplicating a wedding, so both copy exactly what a saved template would.
const LAYOUT_COLUMNS = `label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
  "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape, "positionX", "positionY"`;

interface LayoutTable {
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
}

// A label already used in the wedding gets " (2)", " (3)"… so two tables are never both called
// "Table 1" -- every other attribute is copied as-is.
// TS-180: a table name is at most 100 characters, so a long name is shortened to make room for the
// number (it used to run past the limit, which the table's own edit form then refused).
const MAX_TABLE_LABEL = 100;
function uniqueLabel(label: string, taken: Set<string>): string {
  if (!taken.has(label)) return label;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    // TS-198: cut between whole characters, so an emoji at the cut isn't split in half.
    const candidate = `${cutToLimit(label, MAX_TABLE_LABEL - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function insertLayoutTables(
  client: import("pg").PoolClient,
  weddingId: string,
  tables: LayoutTable[]
): Promise<number> {
  // TS-195: the wedding's lock first (FOR NO KEY UPDATE), so a template added in two tabs at once,
  // or alongside a quick-create, takes turns -- each reads the labels the other just saved, and no
  // two tables end up with the same name. Also stops here, as "this wedding was deleted", if it was.
  await lockWeddingRow(client, weddingId);
  const { rows: existing } = await client.query<{ label: string }>(
    `SELECT label FROM "seating_tables" WHERE "weddingId" = $1`,
    [weddingId]
  );
  const taken = new Set(existing.map((r) => r.label));
  for (const t of tables) {
    const label = uniqueLabel(t.label, taken);
    taken.add(label);
    await client.query(
      `INSERT INTO "seating_tables"
         (id, "weddingId", label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
          "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape, "positionX", "positionY", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::"TablePurposeCriterionType", $10, $11, $12::"TableShape", $13, $14, now())`,
      [
        randomUUID(), weddingId, label, t.capacity, t.isRestricted, t.isAccessible, t.isLocked, t.purpose,
        t.purposeCriterionType, t.purposeCriterionValue, t.singleSideOnly, t.shape, t.positionX, t.positionY,
      ]
    );
  }
  return tables.length;
}

// TS-91: adds a saved template's tables to a wedding that already exists -- until now a template
// could only be applied when creating a wedding. Purely additive: existing tables, guests, rules
// and plans are never touched or removed. Only the template's own owner can apply it.
export async function addTemplateTablesToWedding(
  weddingId: string,
  templateId: string,
  userId: string
): Promise<number> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { rows: owned } = await client.query(
      `SELECT 1 FROM "seating_templates" WHERE id = $1 AND "ownerId" = $2`,
      [templateId, userId]
    );
    if (!owned[0]) throw new TemplateNotFoundError("Template not found.");
    const { rows } = await client.query<LayoutTable>(
      `SELECT ${LAYOUT_COLUMNS} FROM "seating_template_tables" WHERE "templateId" = $1 ORDER BY "sortOrder"`,
      [templateId]
    );
    const added = await insertLayoutTables(client, weddingId, rows);
    await client.query("COMMIT");
    return added;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// TS-91: a brand-new wedding owned by `ownerId` with the source wedding's room layout (every
// table, its position, shape and flags) and seating settings (side mixing and side labels), so a
// planner can reuse a venue without rebuilding it. Deliberately not copied: guests, rules,
// required-guest lists, plans, comments, timeline, vendors -- those belong to the source couple.
export async function duplicateWeddingLayout(
  sourceWeddingId: string,
  ownerId: string,
  name: string
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { rows: src } = await client.query(
      `SELECT "venueName", "sideMixing", "sideLabel1", "sideLabel2" FROM "weddings" WHERE id = $1 AND "ownerId" = $2`,
      [sourceWeddingId, ownerId]
    );
    if (!src[0]) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO "weddings" (id, "ownerId", name, "venueName", "sideMixing", "sideLabel1", "sideLabel2", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"SideMixingSetting", $6, $7, now())`,
      [id, ownerId, name, src[0].venueName, src[0].sideMixing, src[0].sideLabel1, src[0].sideLabel2]
    );
    const { rows: tables } = await client.query<LayoutTable>(
      `SELECT ${LAYOUT_COLUMNS} FROM "seating_tables" WHERE "weddingId" = $1`,
      [sourceWeddingId]
    );
    await insertLayoutTables(client, id, tables.sort((a, b) => compareTableLabels(a.label, b.label)));
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
