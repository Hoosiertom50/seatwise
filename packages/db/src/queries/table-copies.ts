import { randomUUID } from "crypto";
import type { PoolClient } from "pg";

// TS-261: copying a room layout (applying a template, duplicating a wedding, creating a wedding from
// a template, saving a wedding as a template) writes every table in one INSERT -- it used to be one
// INSERT per table, about 300 round trips at the cap. Each column's values travel as one array and
// unnest() lines them back up into rows, in the order given.

/** The structural fields of a table that a layout copy carries over. */
export interface LayoutTableValues {
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

/** $1 = the new ids, $2 = the wedding or template, $3..$14 = one array per layout column. */
function layoutParams(owner: string, tables: LayoutTableValues[]): unknown[] {
  return [
    tables.map(() => randomUUID()),
    owner,
    tables.map((t) => t.label),
    tables.map((t) => t.capacity),
    tables.map((t) => t.isRestricted),
    tables.map((t) => t.isAccessible),
    tables.map((t) => t.isLocked),
    tables.map((t) => t.purpose),
    tables.map((t) => t.purposeCriterionType),
    tables.map((t) => t.purposeCriterionValue),
    tables.map((t) => t.singleSideOnly),
    tables.map((t) => t.shape),
    tables.map((t) => t.positionX),
    tables.map((t) => t.positionY),
  ];
}

// WITH ORDINALITY numbers the rows 1, 2, 3... in the order given (a template's sortOrder).
const LAYOUT_ROWS = `unnest($1::text[], $3::text[], $4::int[], $5::boolean[], $6::boolean[], $7::boolean[], $8::text[],
         $9::text[], $10::text[], $11::boolean[], $12::text[], $13::double precision[], $14::double precision[])
       WITH ORDINALITY AS v(id, label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
         "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape, "positionX", "positionY", n)`;

/**
 * New seating_tables rows in `weddingId`, one per entry, each with a fresh id. Labels are used as
 * given (the caller has already made them unique). Nothing is sent when there are none.
 */
export async function insertSeatingTableCopies(client: PoolClient, weddingId: string, tables: LayoutTableValues[]): Promise<void> {
  if (tables.length === 0) return;
  await client.query(
    `INSERT INTO "seating_tables"
       (id, "weddingId", label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
        "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape, "positionX", "positionY", "updatedAt")
     SELECT v.id, $2, v.label, v.capacity, v."isRestricted", v."isAccessible", v."isLocked", v.purpose,
            v."purposeCriterionType"::"TablePurposeCriterionType", v."purposeCriterionValue", v."singleSideOnly",
            v.shape::"TableShape", v."positionX", v."positionY", now()
       FROM ${LAYOUT_ROWS}
      ORDER BY v.n`,
    layoutParams(weddingId, tables)
  );
}

/**
 * New seating_template_tables rows in `templateId`, one per entry, each with a fresh id; their
 * sortOrder is their place in `tables` (0, 1, 2...). Nothing is sent when there are none.
 */
export async function insertTemplateTableCopies(client: PoolClient, templateId: string, tables: LayoutTableValues[]): Promise<void> {
  if (tables.length === 0) return;
  await client.query(
    `INSERT INTO "seating_template_tables"
       (id, "templateId", label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
        "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape,
        "positionX", "positionY", "sortOrder")
     SELECT v.id, $2, v.label, v.capacity, v."isRestricted", v."isAccessible", v."isLocked", v.purpose,
            v."purposeCriterionType"::"TablePurposeCriterionType", v."purposeCriterionValue", v."singleSideOnly",
            v.shape::"TableShape", v."positionX", v."positionY", (v.n - 1)::int
       FROM ${LAYOUT_ROWS}
      ORDER BY v.n`,
    layoutParams(templateId, tables)
  );
}
