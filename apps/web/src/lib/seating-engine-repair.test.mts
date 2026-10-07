// TS-196: unit tests for the seating engine (packages/shared/src/seating-engine.ts) seating
// everyone it can -- no accessible-table penalty, a retry/repair step when a plan leaves someone
// unseated, and the reasons given when it can't. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateSeatingPlan,
  RULE_WEIGHT_CONFIG,
  RULE_WEIGHT_CONFIG_VERSION,
  type EngineGuest,
  type EngineRelationship,
  type EngineTable,
} from "../../../../packages/shared/src/seating-engine";

const guest = (id: string, extra: Partial<EngineGuest> = {}): EngineGuest => ({
  id,
  name: id,
  headcount: 1,
  requiresAccessibleTable: false,
  isLocked: false,
  currentTableId: null,
  side: "BOTH",
  tier: "OTHER",
  ageCategory: "ADULT",
  requiredTableId: null,
  ...extra,
});

const table = (id: string, capacity: number, extra: Partial<EngineTable> = {}): EngineTable => ({
  id,
  label: id,
  capacity,
  isRestricted: false,
  isAccessible: false,
  isLocked: false,
  singleSideOnly: false,
  purposeCriterion: null,
  ...extra,
});

const tableOf = (result: ReturnType<typeof generateSeatingPlan>, guestId: string) =>
  result.assignments.find((a) => a.guestId === guestId)?.tableId ?? null;

test("the accessible-table penalty is gone, and the weighting version says so", () => {
  // TS-226: version 6 (one more order for accessible seats; see seating-engine-ts226.test.mts).
  // TS-236: version 7 (tie-breaks and the repair's table pick; see seating-engine-ts236.test.mts).
  assert.equal(RULE_WEIGHT_CONFIG_VERSION, 7);
  assert.equal("accessibleTableMisusePenalty" in RULE_WEIGHT_CONFIG, false);
});

// F5: nobody needs an accessible table, yet the old penalty pushed the 4 to the plain 6-top and
// left one of the 3s with nowhere to sit.
test("parties of 4, 3 and 3 all fit an accessible 4-top and a plain 6-top", () => {
  const result = generateSeatingPlan(
    [guest("Fam4", { headcount: 4 }), guest("A3", { headcount: 3 }), guest("B3", { headcount: 3 })],
    [],
    [table("Acc", 4, { isAccessible: true }), table("Plain", 6)]
  );
  assert.equal(result.isComplete, true);
  assert.equal(tableOf(result, "Fam4"), "Acc");
  assert.equal(tableOf(result, "A3"), "Plain");
  assert.equal(tableOf(result, "B3"), "Plain");
});

// F2: seating the wheelchair user first put them at the small table, and the two 4s then had only
// the 6-top between them. The repair moves them to the big table to make room.
test("seating an accessible guest first doesn't strand a party when moving them makes room", () => {
  const result = generateSeatingPlan(
    [guest("Party1", { headcount: 4 }), guest("Party2", { headcount: 4 }), guest("Wheel", { requiresAccessibleTable: true })],
    [],
    [table("Small", 4, { isAccessible: true }), table("Big", 6, { isAccessible: true })]
  );
  assert.equal(result.isComplete, true);
  assert.deepEqual(result.unassignedGuestIds, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(tableOf(result, "Wheel"), "Big");
  assert.equal(tableOf(result, "Party1"), "Big");
  assert.equal(tableOf(result, "Party2"), "Small");
  // Without the repair step the same wedding leaves Party2 unseated.
  const plain = generateSeatingPlan(
    [guest("Party1", { headcount: 4 }), guest("Party2", { headcount: 4 }), guest("Wheel", { requiresAccessibleTable: true })],
    [],
    [table("Small", 4, { isAccessible: true }), table("Big", 6, { isAccessible: true })],
    "BALANCED_MIX",
    { repair: false }
  );
  assert.deepEqual(plain.unassignedGuestIds, ["Party2"]);
});

test("the repair never moves a locked guest or someone at a locked table to make room", () => {
  const result = generateSeatingPlan(
    [
      guest("Keep", { isLocked: true, currentTableId: "Small" }),
      guest("Party1", { headcount: 4 }),
      guest("Party2", { headcount: 4 }),
    ],
    [],
    [table("Small", 4), table("Big", 6)]
  );
  assert.equal(tableOf(result, "Keep"), "Small");
  assert.equal(result.unassignedGuestIds.length, 1);
});

// The move that would make room is blocked by a "must not sit together" rule, so the plain
// largest-first order is tried instead -- and it seats everyone.
test("when the repair can't make room, the largest-first order is tried", () => {
  const result = generateSeatingPlan(
    [guest("Party1", { headcount: 4 }), guest("Party2", { headcount: 4 }), guest("Wheel", { requiresAccessibleTable: true })],
    [{ guestAId: "Wheel", guestBId: "Party1", type: "MUST_NOT_SIT_TOGETHER" }],
    [table("Small", 4, { isAccessible: true }), table("Big", 6, { isAccessible: true })]
  );
  assert.equal(result.isComplete, true);
  assert.equal(tableOf(result, "Party1"), "Small");
  assert.equal(tableOf(result, "Party2"), "Big");
  assert.equal(tableOf(result, "Wheel"), "Big");
});

test("the repair never seats someone next to a guest they must not sit with", () => {
  const result = generateSeatingPlan(
    [guest("Party1", { headcount: 4 }), guest("Party2", { headcount: 4 }), guest("Wheel", { requiresAccessibleTable: true })],
    [
      { guestAId: "Wheel", guestBId: "Party1", type: "MUST_NOT_SIT_TOGETHER" },
      { guestAId: "Wheel", guestBId: "Party2", type: "MUST_NOT_SIT_TOGETHER" },
    ],
    [table("Small", 4, { isAccessible: true }), table("Big", 6, { isAccessible: true })]
  );
  for (const party of ["Party1", "Party2"]) {
    if (tableOf(result, "Wheel")) assert.notEqual(tableOf(result, "Wheel"), tableOf(result, party));
  }
  assert.equal(result.unassignedGuestIds.length, 1);
});

// F1: a lock that can't be kept and can't be re-seated gets one message, not two that disagree.
test("a lock that can't be kept or re-seated says so in one message", () => {
  const result = generateSeatingPlan(
    [guest("Ann", { isLocked: true, currentTableId: "T1", requiresAccessibleTable: true }), guest("Bob", { headcount: 4 })],
    [],
    [table("T1", 4), table("T2", 4)]
  );
  assert.deepEqual(result.unassignedGuestIds, ["Ann"]);
  const aboutAnn = result.warnings.filter((w) => w.includes("Ann"));
  assert.deepEqual(aboutAnn, [
    `Guest Ann is locked to "T1", but that's no longer possible — and couldn't be seated: there's no accessible table.`,
  ]);
  assert.doesNotMatch(result.warnings.join("\n"), /seated automatically instead/);
});

// F3: a locked (or Restricted) table is big enough, so the party isn't bigger than *any* table.
test("a party too big for every open table, but not for a locked one, is told which tables", () => {
  const result = generateSeatingPlan(
    [guest("Fam", { headcount: 6 }), guest("Kept", { currentTableId: "L" })],
    [],
    [table("L", 10, { isLocked: true }), table("T2", 4)]
  );
  assert.equal(tableOf(result, "Kept"), "L");
  assert.match(
    result.warnings.join("\n"),
    /Couldn't seat guest Fam — their party of 6 is bigger than any unlocked, unrestricted table\./
  );
});

test("a party too big for every open accessible table, but not a Restricted one, is told which tables", () => {
  const result = generateSeatingPlan(
    [guest("W", { headcount: 5, requiresAccessibleTable: true })],
    [],
    [table("VIP", 8, { isAccessible: true, isRestricted: true }), table("Acc", 4, { isAccessible: true }), table("T2", 8)]
  );
  assert.match(
    result.warnings.join("\n"),
    /their party of 5 is bigger than any unlocked, unrestricted accessible table\./
  );
});

test("a party bigger than every table, locked ones included, is still told it's bigger than any table", () => {
  const result = generateSeatingPlan([guest("Fam", { headcount: 12 })], [], [table("L", 10, { isLocked: true }), table("T2", 4)]);
  assert.match(result.warnings.join("\n"), /their party of 12 is bigger than any table\./);
});

// F4: same-named guests come back in a set order from the database (TS-196 adds a guest id
// tie-break there); the engine itself is deterministic for whatever order it's given.
test("the same input always gives the same plan", () => {
  const guests = [guest("id-1", { name: "Sam Lee", side: "BRIDE" }), guest("id-2", { name: "Sam Lee", side: "GROOM" })];
  const tables = [table("A", 1), table("B", 1)];
  assert.deepEqual(generateSeatingPlan(guests, [], tables), generateSeatingPlan(guests, [], tables));
  assert.equal(tableOf(generateSeatingPlan(guests, [], tables), "id-1"), "A");
});

// A small seeded property test: random weddings (locks, locked and Restricted tables, accessible
// needs, must / must-not rules, soft preferences) must always keep every hard rule, give the same
// plan every time, and never leave more guests unseated than the engine without the repair step.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("2,000 random weddings: hard rules always hold, and the repair never leaves more accessible-needing people (nor, otherwise, more people) unseated", () => {
  const rnd = mulberry32(196);
  const ri = (n: number) => Math.floor(rnd() * n);
  const pick = <T,>(a: readonly T[]) => a[ri(a.length)];
  let repairedMore = 0;
  for (let iter = 0; iter < 2000; iter++) {
    const tables: EngineTable[] = [];
    const nt = 1 + ri(6);
    for (let i = 0; i < nt; i++) {
      tables.push(
        table(`T${i}`, ri(9), {
          isRestricted: rnd() < 0.15,
          isAccessible: rnd() < 0.35,
          isLocked: rnd() < 0.15,
          singleSideOnly: rnd() < 0.15,
          purposeCriterion: rnd() < 0.15 ? { type: "SIDE", value: "BRIDE" } : null,
        })
      );
    }
    const guests: EngineGuest[] = [];
    const ng = 1 + ri(14);
    for (let i = 0; i < ng; i++) {
      const current = rnd() < 0.4 ? (rnd() < 0.9 ? pick(tables).id : "Gone") : null;
      guests.push(
        // Names like "g3x" so one guest's name is never part of another's ("g1x" vs "g11x").
        guest(`G${i}`, {
          name: `g${i}x`,
          headcount: 1 + ri(4),
          requiresAccessibleTable: rnd() < 0.2,
          isLocked: rnd() < 0.2,
          currentTableId: current,
          side: pick(["BRIDE", "GROOM", "BOTH"] as const),
        })
      );
    }
    for (const t of tables.filter((t) => t.isRestricted)) {
      for (const g of guests) if (!g.requiredTableId && rnd() < 0.2) g.requiredTableId = t.id;
    }
    const rels: EngineRelationship[] = [];
    const nr = ri(10);
    for (let i = 0; i < nr; i++) {
      const a = pick(guests).id;
      const b = pick(guests).id;
      if (a !== b) {
        rels.push({ guestAId: a, guestBId: b, type: pick(["MUST_SIT_TOGETHER", "MUST_NOT_SIT_TOGETHER", "MUST_NOT_SIT_TOGETHER", "PREFER_NEAR", "AVOID"] as const) });
      }
    }
    const mix = pick(["KEEP_SEPARATE", "BALANCED_MIX", "FULLY_MIXED"] as const);
    const input = JSON.stringify({ guests, rels, tables, mix });

    const result = generateSeatingPlan(guests, rels, tables, mix);
    if (result.errors.length > 0) continue;
    assert.deepEqual(generateSeatingPlan(guests, rels, tables, mix), result, `not deterministic: ${input}`);
    const plain = generateSeatingPlan(guests, rels, tables, mix, { repair: false });
    // TS-201: the engine keeps the plan that leaves the fewest people who need an accessible table
    // unseated, then the fewest PEOPLE (party sizes), so the repair must never make the first
    // worse, nor the second worse unless the first got better.
    const people = (ids: string[]) => ids.reduce((n, id) => n + (guests.find((g) => g.id === id)?.headcount ?? 0), 0);
    const accessiblePeople = (ids: string[]) =>
      people(ids.filter((id) => guests.find((g) => g.id === id)?.requiresAccessibleTable));
    const accResult = accessiblePeople(result.unassignedGuestIds);
    const accPlain = accessiblePeople(plain.unassignedGuestIds);
    assert.ok(accResult <= accPlain, `left more people who need an accessible table unseated: ${input}`);
    assert.ok(
      accResult < accPlain || people(result.unassignedGuestIds) <= people(plain.unassignedGuestIds),
      `repair seated fewer people: ${input}`
    );
    if (people(result.unassignedGuestIds) < people(plain.unassignedGuestIds)) repairedMore++;

    const seatedAt = new Map(result.assignments.map((a) => [a.guestId, a.tableId]));
    const unseated = new Set(result.unassignedGuestIds);
    const byId = new Map(guests.map((g) => [g.id, g]));
    for (const g of guests) {
      const times = result.assignments.filter((a) => a.guestId === g.id).length + (unseated.has(g.id) ? 1 : 0);
      assert.equal(times, 1, `guest ${g.id} listed ${times} times: ${input}`);
      const at = seatedAt.get(g.id);
      if (g.requiredTableId && at) assert.equal(at, g.requiredTableId, `required guest seated elsewhere: ${input}`);
      if (unseated.has(g.id)) assert.ok(result.warnings.some((w) => w.includes(g.name)), `unseated without a warning: ${input}`);
    }
    for (const t of tables) {
      const here = result.assignments.filter((a) => a.tableId === t.id).map((a) => byId.get(a.guestId)!);
      assert.ok(here.reduce((s, g) => s + g.headcount, 0) <= t.capacity, `over capacity: ${input}`);
      for (const g of here) {
        if (g.requiresAccessibleTable) assert.ok(t.isAccessible, `accessible need broken: ${input}`);
        if (t.isRestricted) assert.equal(g.requiredTableId, t.id, `unlisted guest at a Restricted table: ${input}`);
        if (t.isLocked) {
          assert.ok(g.currentTableId === t.id || g.requiredTableId === t.id, `newcomer at a locked table: ${input}`);
        }
      }
    }
    for (const r of rels) {
      const a = seatedAt.get(r.guestAId);
      const b = seatedAt.get(r.guestBId);
      if (r.type === "MUST_NOT_SIT_TOGETHER") assert.ok(!a || a !== b, `must-not broken: ${input}`);
      if (r.type === "MUST_SIT_TOGETHER") {
        if (a && b) assert.equal(a, b, `must-sit split: ${input}`);
        // Only the settled locked-table case may seat one of a must-sit pair without the other.
        if (!!a !== !!b) {
          const missing = byId.get(a ? r.guestBId : r.guestAId)!;
          assert.ok(
            // TS-201: "Unlock it or ..." or, when they have their own locked seat, 'Unlock "L" or ...'.
            result.warnings.some((w) => w.includes(missing.name) && /or move them together\./.test(w)),
            `must-sit pair half seated outside the locked-table case: ${input}`
          );
        }
      }
    }
  }
  // The generator really does produce weddings the repair helps with.
  assert.ok(repairedMore > 0);
});
