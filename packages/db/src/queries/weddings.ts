import { randomUUID } from "crypto";
import { pool } from "../pool";
import { TemplateNotFoundError } from "./templates";

export interface WeddingRow {
  id: string;
  ownerId: string;
  name: string;
  eventDate: string | null;
  venueName: string | null;
  // FR-1.3
  note: string | null;
  status: string;
  guestCount: number;
  emailNotificationsEnabled: boolean;
  // FR-3.4
  sideMixing: string;
  // FR-1.3a
  sideLabel1: string;
  sideLabel2: string;
  // TS-17 (FR-12.2): null means no RSVP cutoff at all.
  rsvpCutoffDate: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// FR-11.2: the planner-portfolio dashboard's row-level summary (Current Plan Version's status,
// plus its unassigned/Needs Reassignment counts) so a planner can see "does this wedding need
// attention" without opening it. Only listWeddingsWithSummaryForUser below returns these three --
// every other read in this file returns the plain WeddingRow, unchanged.
export interface WeddingSummaryRow extends WeddingRow {
  // null: no plan version has been generated for this wedding yet.
  planStatus: string | null;
  unassignedCount: number;
  needsReassignmentCount: number;
}

const SELECT_WITH_GUEST_COUNT = `
  SELECT w.id, w."ownerId", w.name, w."eventDate"::text AS "eventDate", w."venueName", w.note,
         w.status, w."emailNotificationsEnabled", w."sideMixing", w."sideLabel1", w."sideLabel2",
         w."rsvpCutoffDate"::text AS "rsvpCutoffDate",
         w."createdAt", w."updatedAt",
         COALESCE(g.count, 0)::int AS "guestCount"
  FROM "weddings" w
  LEFT JOIN (
    SELECT "weddingId", COUNT(*) AS count FROM "guests" GROUP BY "weddingId"
  ) g ON g."weddingId" = w.id
`;

// FR-11.1/FR-11.2: same base as SELECT_WITH_GUEST_COUNT, plus each wedding's Current Plan Version
// (highest versionNumber, via LATERAL -- there's at most one "current" per wedding so this can't
// fan out rows the way a plain join could) and, scoped to that one version, the same
// unassigned/needsReassignment counting formula used everywhere else a plan version's completeness
// is checked (see plan-versions.ts). When a wedding has no plan version yet, cpv.id is NULL --
// "planStatus" comes back null (rendered as "No plan yet"), "needsReassignmentCount" correctly
// comes back 0 (nothing to reassign without a plan), and "unassignedCount" correctly falls back to
// every Attending guest (nothing's assigned to anything, so all of them are unassigned) since the
// NOT EXISTS below never matches a NULL planVersionId.
const SELECT_WITH_SUMMARY = `
  SELECT w.id, w."ownerId", w.name, w."eventDate"::text AS "eventDate", w."venueName", w.note,
         w.status, w."emailNotificationsEnabled", w."sideMixing", w."sideLabel1", w."sideLabel2",
         w."rsvpCutoffDate"::text AS "rsvpCutoffDate",
         w."createdAt", w."updatedAt",
         COALESCE(g.count, 0)::int AS "guestCount",
         cpv.status AS "planStatus",
         COALESCE(unassigned.count, 0)::int AS "unassignedCount",
         COALESCE(reassign.count, 0)::int AS "needsReassignmentCount"
  FROM "weddings" w
  LEFT JOIN (
    SELECT "weddingId", COUNT(*) AS count FROM "guests" GROUP BY "weddingId"
  ) g ON g."weddingId" = w.id
  LEFT JOIN LATERAL (
    SELECT id, status FROM "plan_versions" pv
    WHERE pv."weddingId" = w.id AND pv."isCurrent" LIMIT 1
  ) cpv ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS count FROM "guests" ag
    WHERE ag."weddingId" = w.id AND ag."dayOfAttendance" = 'ATTENDING'
      AND NOT EXISTS (
        SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = cpv.id AND sa."guestId" = ag.id
      )
  ) unassigned ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS count FROM "seat_assignments" sa2
    WHERE sa2."planVersionId" = cpv.id AND sa2."needsReassignment" = true
  ) reassign ON true
`;

// TS-19 (FR-14.4): optionally seeds the new wedding from an existing template the caller owns.
// applyTemplateRules overrides sideMixing with the template's own setting (taking precedence over
// whatever input.sideMixing carries, matching "start from the template" rather than "start from
// the template but only for the fields I didn't already set"); applyTemplateTables clones every
// one of the template's tables in as brand-new, independent seating_tables rows -- there's no
// ongoing link back to the template afterward, so everything cloned in is immediately and freely
// editable (AC4), same as a table created by hand. Both the wedding insert and every cloned table
// happen in one transaction, so a template mid-application can never leave a half-seeded wedding.
export async function createWedding(
  ownerId: string,
  input: {
    name: string;
    eventDate?: string | null;
    venueName?: string | null;
    note?: string | null;
    sideMixing?: string;
    sideLabel1?: string;
    sideLabel2?: string;
    rsvpCutoffDate?: string | null;
    templateId?: string;
    applyTemplateTables?: boolean;
    applyTemplateRules?: boolean;
  }
): Promise<WeddingRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let sideMixing = input.sideMixing ?? null;
    let templateTables: Array<{
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
    }> = [];

    if (input.templateId) {
      const { rows: templateRows } = await client.query(
        `SELECT "sideMixing" FROM "seating_templates" WHERE id = $1 AND "ownerId" = $2`,
        [input.templateId, ownerId]
      );
      const template = templateRows[0];
      if (!template) throw new TemplateNotFoundError("Template not found.");

      if (input.applyTemplateRules) {
        sideMixing = template.sideMixing;
      }
      if (input.applyTemplateTables) {
        const { rows } = await client.query(
          `SELECT label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
                  "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape,
                  "positionX", "positionY"
           FROM "seating_template_tables" WHERE "templateId" = $1 ORDER BY "sortOrder"`,
          [input.templateId]
        );
        templateTables = rows;
      }
    }

    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO "weddings" (id, "ownerId", name, "eventDate", "venueName", note, "sideMixing", "sideLabel1", "sideLabel2", "rsvpCutoffDate", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::"SideMixingSetting", 'BALANCED_MIX'), COALESCE($8, 'Bride'), COALESCE($9, 'Groom'), $10, now())
       RETURNING id, "ownerId", name, "eventDate"::text AS "eventDate", "venueName", note, status,
                 "emailNotificationsEnabled", "sideMixing", "sideLabel1", "sideLabel2",
                 "rsvpCutoffDate"::text AS "rsvpCutoffDate", "createdAt", "updatedAt"`,
      [
        id,
        ownerId,
        input.name,
        input.eventDate ?? null,
        input.venueName ?? null,
        input.note ?? null,
        sideMixing,
        input.sideLabel1 ?? null,
        input.sideLabel2 ?? null,
        input.rsvpCutoffDate ?? null,
      ]
    );
    const wedding = rows[0];

    for (const t of templateTables) {
      await client.query(
        `INSERT INTO "seating_tables"
           (id, "weddingId", label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
            "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape, "positionX", "positionY", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::"TablePurposeCriterionType", $10, $11, $12::"TableShape", $13, $14, now())`,
        [
          randomUUID(),
          id,
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
        ]
      );
    }

    await client.query("COMMIT");
    return { ...wedding, guestCount: 0 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listWeddingsByOwner(ownerId: string): Promise<WeddingRow[]> {
  const { rows } = await pool.query(
    `${SELECT_WITH_GUEST_COUNT} WHERE w."ownerId" = $1 ORDER BY w."createdAt" DESC`,
    [ownerId]
  );
  return rows;
}

export async function getWeddingForOwner(id: string, ownerId: string): Promise<WeddingRow | null> {
  const { rows } = await pool.query(
    `${SELECT_WITH_GUEST_COUNT} WHERE w.id = $1 AND w."ownerId" = $2`,
    [id, ownerId]
  );
  return rows[0] ?? null;
}

// TS-13: unlike getWeddingForOwner, this doesn't check ownership — callers pair it with
// getWeddingAccessLevel() so a View/Comment/Edit collaborator (not just the owner) can load it.
export async function getWeddingById(id: string): Promise<WeddingRow | null> {
  const { rows } = await pool.query(`${SELECT_WITH_GUEST_COUNT} WHERE w.id = $1`, [id]);
  return rows[0] ?? null;
}

// TS-13: the dashboard's "your weddings" list needs to include weddings a user has been given
// collaborator access to, not only ones they own.
export async function listWeddingsAccessibleToUser(userId: string): Promise<WeddingRow[]> {
  const { rows } = await pool.query(
    `${SELECT_WITH_GUEST_COUNT}
     WHERE w."ownerId" = $1
        OR w.id IN (SELECT "weddingId" FROM "wedding_collaborators" WHERE "userId" = $1)
     ORDER BY w."createdAt" DESC`,
    [userId]
  );
  return rows;
}

// FR-11.1/FR-11.2: the planner-portfolio dashboard's version of the above -- same access rule
// (owned or collaborator-on), enriched with each wedding's plan status and unassigned/Needs
// Reassignment counts. Sorting, filtering, and searching this list all happen client-side (see
// dashboard/page.tsx) rather than as query params here: at the stated portfolio scale (dozens,
// 15-50+ weddings per planner) filtering an already-fetched array is instant and far simpler than
// a parameterized WHERE/ORDER BY builder -- this can grow a real query-param API later if a
// planner's portfolio ever gets large enough for that to matter.
export async function listWeddingsWithSummaryForUser(userId: string): Promise<WeddingSummaryRow[]> {
  const { rows } = await pool.query(
    `${SELECT_WITH_SUMMARY}
     WHERE w."ownerId" = $1
        OR w.id IN (SELECT "weddingId" FROM "wedding_collaborators" WHERE "userId" = $1)
     ORDER BY w."createdAt" DESC`,
    [userId]
  );
  return rows;
}

export async function setEmailNotificationsEnabled(id: string, ownerId: string, enabled: boolean): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE "weddings" SET "emailNotificationsEnabled" = $1, "updatedAt" = now() WHERE id = $2 AND "ownerId" = $3`,
    [enabled, id, ownerId]
  );
  return (rowCount ?? 0) > 0;
}

export async function updateWeddingForOwner(
  id: string,
  ownerId: string,
  input: Partial<{
    name: string;
    eventDate: string | null;
    venueName: string | null;
    note: string | null;
    sideMixing: string;
    sideLabel1: string;
    sideLabel2: string;
    rsvpCutoffDate: string | null;
  }>
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (input.name !== undefined) {
    fields.push(`name = $${i++}`);
    values.push(input.name);
  }
  if (input.eventDate !== undefined) {
    fields.push(`"eventDate" = $${i++}`);
    values.push(input.eventDate);
  }
  if (input.venueName !== undefined) {
    fields.push(`"venueName" = $${i++}`);
    values.push(input.venueName);
  }
  if (input.note !== undefined) {
    fields.push(`note = $${i++}`);
    values.push(input.note);
  }
  if (input.sideMixing !== undefined) {
    fields.push(`"sideMixing" = $${i++}::"SideMixingSetting"`);
    values.push(input.sideMixing);
  }
  // FR-1.3a: a pure label rename -- never touches guests."side", any rule, or any assignment.
  if (input.sideLabel1 !== undefined) {
    fields.push(`"sideLabel1" = $${i++}`);
    values.push(input.sideLabel1);
  }
  if (input.sideLabel2 !== undefined) {
    fields.push(`"sideLabel2" = $${i++}`);
    values.push(input.sideLabel2);
  }
  // FR-12.2: null clears the cutoff (no cutoff at all), matching the FR's "or none" language.
  if (input.rsvpCutoffDate !== undefined) {
    fields.push(`"rsvpCutoffDate" = $${i++}`);
    values.push(input.rsvpCutoffDate);
  }
  fields.push(`"updatedAt" = now()`);
  values.push(id, ownerId);
  const { rowCount } = await pool.query(
    `UPDATE "weddings" SET ${fields.join(", ")} WHERE id = $${i++} AND "ownerId" = $${i}`,
    values
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteWeddingForOwner(id: string, ownerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM "weddings" WHERE id = $1 AND "ownerId" = $2`,
    [id, ownerId]
  );
  return (rowCount ?? 0) > 0;
}
