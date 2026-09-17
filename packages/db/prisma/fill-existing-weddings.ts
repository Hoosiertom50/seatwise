// Fills in guest list, seating rules, table layout, and a generated seating plan for any
// existing wedding that's currently missing them -- written to run once against local dev
// weddings created by hand (with no rules or seating plan yet), instead of clicking through
// each tab manually.
//
// Safe to re-run: each category (guests / tables / rules / plan version) is only filled when
// that wedding doesn't already have any of that category, so a second run never duplicates data,
// and a wedding that's already fully populated (e.g. prisma/seed.ts's own demo weddings) is left
// completely untouched.
//
// Usage (from the repo root):
//   pnpm --filter @seatwise/db fill-existing

import "./load-env";

import {
  pool,
  createGuest,
  listGuestsByWedding,
  quickCreateSeatingTables,
  listSeatingTablesForWedding,
  createRelationship,
  createPlanVersionWithAssignments,
} from "../src/index";
import { generateSeatingPlan, RULE_WEIGHT_CONFIG_VERSION } from "@seatwise/shared";
import type { EngineGuest, EngineRelationship, EngineTable } from "@seatwise/shared";

interface WeddingRow {
  id: string;
  name: string;
  sideMixing: string;
}

const SAMPLE_GUESTS: Array<{
  firstName: string;
  lastName: string;
  tier?: string;
  side?: string;
  rsvpStatus?: string;
  headcount?: number;
  plusOneNames?: string;
  ageCategory?: string;
  requiresAccessibleTable?: boolean;
}> = [
  { firstName: "Priya", lastName: "Nair", tier: "FAMILY", side: "BRIDE", rsvpStatus: "CONFIRMED" },
  { firstName: "Sam", lastName: "Okafor", tier: "FAMILY", side: "BRIDE", rsvpStatus: "CONFIRMED" },
  { firstName: "Lena", lastName: "Cho", tier: "FRIEND", side: "GROOM", rsvpStatus: "CONFIRMED", headcount: 2, plusOneNames: "Marco Diaz" },
  { firstName: "Marco", lastName: "Diaz", tier: "FRIEND", side: "GROOM", rsvpStatus: "PENDING" },
  { firstName: "Ruth", lastName: "Bennett", tier: "VIP", side: "BOTH", rsvpStatus: "CONFIRMED" },
  { firstName: "Theo", lastName: "Bennett", tier: "VIP", side: "BOTH", rsvpStatus: "DECLINED" },
  { firstName: "Ivy", lastName: "Park", tier: "OTHER", side: "BRIDE", rsvpStatus: "PENDING", ageCategory: "CHILD" },
  { firstName: "Dana", lastName: "Rivera", tier: "FAMILY", side: "BRIDE", rsvpStatus: "CONFIRMED" },
  { firstName: "Noah", lastName: "Kim", tier: "FAMILY", side: "GROOM", rsvpStatus: "CONFIRMED" },
  { firstName: "Grace", lastName: "Lund", tier: "FRIEND", side: "BOTH", rsvpStatus: "CONFIRMED" },
  { firstName: "Owen", lastName: "Marsh", tier: "FRIEND", side: "GROOM", rsvpStatus: "CONFIRMED" },
  { firstName: "Alina", lastName: "Petrov", tier: "FRIEND", side: "BRIDE", rsvpStatus: "CONFIRMED" },
  { firstName: "Jamal", lastName: "Reed", tier: "FAMILY", side: "GROOM", rsvpStatus: "CONFIRMED", requiresAccessibleTable: true },
  { firstName: "Chloe", lastName: "Bishop", tier: "FRIEND", side: "BRIDE", rsvpStatus: "PENDING" },
  { firstName: "Victor", lastName: "Nguyen", tier: "OTHER", side: "GROOM", rsvpStatus: "CONFIRMED" },
  { firstName: "Faith", lastName: "Adeyemi", tier: "FAMILY", side: "BOTH", rsvpStatus: "CONFIRMED" },
  { firstName: "Milo", lastName: "Santos", tier: "FRIEND", side: "GROOM", rsvpStatus: "CONFIRMED", ageCategory: "CHILD" },
  { firstName: "Harper", lastName: "Voss", tier: "PLUS_ONE", side: "BRIDE", rsvpStatus: "CONFIRMED" },
  { firstName: "Elias", lastName: "Brandt", tier: "FRIEND", side: "GROOM", rsvpStatus: "CONFIRMED" },
  { firstName: "Nadia", lastName: "Farouk", tier: "FRIEND", side: "BRIDE", rsvpStatus: "CONFIRMED" },
  { firstName: "Caleb", lastName: "Whitfield", tier: "FAMILY", side: "GROOM", rsvpStatus: "CONFIRMED" },
  { firstName: "Sophie", lastName: "Laurent", tier: "FRIEND", side: "BOTH", rsvpStatus: "PENDING" },
  { firstName: "Derek", lastName: "Holt", tier: "OTHER", side: "GROOM", rsvpStatus: "DECLINED" },
  { firstName: "Rosa", lastName: "Delgado", tier: "FAMILY", side: "BRIDE", rsvpStatus: "CONFIRMED" },
];

async function fillGuestsIfEmpty(wedding: WeddingRow) {
  const existing = await listGuestsByWedding(wedding.id);
  if (existing.length > 0) {
    console.log(`  guests: already has ${existing.length}, leaving as-is`);
    return existing;
  }
  const created = [];
  for (const g of SAMPLE_GUESTS) {
    created.push(await createGuest(wedding.id, g));
  }
  console.log(`  guests: created ${created.length}`);
  return created;
}

async function fillTablesIfEmpty(wedding: WeddingRow, totalHeadcount: number) {
  const existing = await listSeatingTablesForWedding(wedding.id);
  if (existing.length > 0) {
    console.log(`  tables: already has ${existing.length}, leaving as-is`);
    return existing;
  }
  const count = Math.max(1, Math.ceil(totalHeadcount / 8) + 1); // one spare table of headroom
  const created = await quickCreateSeatingTables(wedding.id, {
    count,
    capacity: 8,
    shape: "ROUND",
    labelPrefix: "Table",
  });
  console.log(`  tables: created ${created.length} (capacity 8 each)`);
  return created;
}

async function fillRulesIfEmpty(wedding: WeddingRow, guests: { id: string }[]) {
  const { rows } = await pool.query(
    `SELECT id FROM "guest_relationships" WHERE "weddingId" = $1 LIMIT 1`,
    [wedding.id]
  );
  if (rows.length > 0) {
    console.log(`  rules: already has some, leaving as-is`);
    return;
  }
  if (guests.length < 10) {
    console.log(`  rules: skipped, fewer than 10 guests to safely pick sample pairs from`);
    return;
  }
  const pairs: { a: number; b: number; type: "MUST_SIT_TOGETHER" | "MUST_NOT_SIT_TOGETHER" | "PREFER_NEAR" | "AVOID" }[] = [
    { a: 0, b: 1, type: "MUST_SIT_TOGETHER" },
    { a: 2, b: 3, type: "MUST_SIT_TOGETHER" },
    { a: 4, b: 5, type: "MUST_NOT_SIT_TOGETHER" },
    { a: 6, b: 7, type: "PREFER_NEAR" },
    { a: 8, b: 9, type: "AVOID" },
  ];
  let created = 0;
  for (const p of pairs) {
    if (p.a >= guests.length || p.b >= guests.length) continue;
    await createRelationship(wedding.id, { guestAId: guests[p.a].id, guestBId: guests[p.b].id, type: p.type });
    created++;
  }
  console.log(`  rules: created ${created} (2 must-sit-together, 1 must-not-sit-together, 1 prefer-near, 1 avoid)`);
}

async function fillPlanIfEmpty(
  wedding: WeddingRow,
  guests: Array<{
    id: string;
    firstName: string;
    lastName: string;
    headcount: number;
    requiresAccessibleTable: boolean;
    isLocked: boolean;
    side: string;
    tier: string;
    ageCategory: string;
    requiredTableId: string | null;
  }>,
  tables: Array<{
    id: string;
    label: string;
    capacity: number;
    isRestricted: boolean;
    isAccessible: boolean;
    isLocked: boolean;
    singleSideOnly: boolean;
    purposeCriterionType: string | null;
    purposeCriterionValue: string | null;
  }>
) {
  const { rows } = await pool.query(`SELECT id FROM "plan_versions" WHERE "weddingId" = $1 LIMIT 1`, [wedding.id]);
  if (rows.length > 0) {
    console.log(`  seating plan: already has a version, leaving as-is`);
    return;
  }
  const { rows: relRows } = await pool.query(
    `SELECT "guestAId", "guestBId", type FROM "guest_relationships" WHERE "weddingId" = $1`,
    [wedding.id]
  );

  const engineGuests: EngineGuest[] = guests.map((g) => ({
    id: g.id,
    name: `${g.firstName} ${g.lastName}`,
    headcount: g.headcount,
    requiresAccessibleTable: g.requiresAccessibleTable,
    isLocked: g.isLocked,
    currentTableId: null,
    side: g.side as EngineGuest["side"],
    tier: g.tier as EngineGuest["tier"],
    ageCategory: g.ageCategory as EngineGuest["ageCategory"],
    requiredTableId: g.requiredTableId ?? null,
  }));
  const engineRelationships: EngineRelationship[] = relRows.map((r) => ({
    guestAId: r.guestAId,
    guestBId: r.guestBId,
    type: r.type,
  }));
  const engineTables: EngineTable[] = tables.map((t) => ({
    id: t.id,
    label: t.label,
    capacity: t.capacity,
    isRestricted: t.isRestricted,
    isAccessible: t.isAccessible,
    isLocked: t.isLocked,
    singleSideOnly: t.singleSideOnly,
    purposeCriterion:
      t.purposeCriterionType && t.purposeCriterionValue
        ? { type: t.purposeCriterionType as EngineTable["purposeCriterion"] extends infer P ? P extends { type: infer T } ? T : never : never, value: t.purposeCriterionValue }
        : null,
  }));

  const result = generateSeatingPlan(
    engineGuests,
    engineRelationships,
    engineTables,
    wedding.sideMixing as Parameters<typeof generateSeatingPlan>[3]
  );
  if (result.errors.length > 0) {
    console.log(`  seating plan: engine reported errors, skipping: ${result.errors.join("; ")}`);
    return;
  }
  await createPlanVersionWithAssignments(wedding.id, {
    isComplete: result.isComplete,
    warnings: result.warnings,
    assignments: result.assignments,
    unassignedGuestIds: result.unassignedGuestIds,
    sideMixingSetting: wedding.sideMixing,
    ruleConfigVersion: result.scoreReport?.ruleConfigVersion ?? RULE_WEIGHT_CONFIG_VERSION,
    makeCurrent: true,
  });
  console.log(
    `  seating plan: created v1 (${result.assignments.length} seated, ${result.unassignedGuestIds.length} unassigned, ${result.warnings.length} warnings)`
  );
}

async function main() {
  const { rows: weddings } = await pool.query<WeddingRow>(
    `SELECT id, name, "sideMixing" FROM "weddings" ORDER BY "createdAt"`
  );
  console.log(`Found ${weddings.length} wedding(s) total.\n`);

  for (const wedding of weddings) {
    console.log(`"${wedding.name}" (${wedding.id})`);
    const guests = await fillGuestsIfEmpty(wedding);
    const totalHeadcount = guests.reduce((sum, g) => sum + g.headcount, 0);
    const tables = await fillTablesIfEmpty(wedding, totalHeadcount);
    await fillRulesIfEmpty(wedding, guests);
    await fillPlanIfEmpty(wedding, guests, tables);
    console.log("");
  }

  console.log("Done. Refresh the app in your browser to see the new data.");
}

main()
  .catch((err) => {
    console.error("Fill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
