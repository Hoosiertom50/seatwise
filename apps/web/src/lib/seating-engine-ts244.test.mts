// TS-244: unit tests for the seating engine (packages/shared/src/seating-engine.ts) -- a repaired
// plan's warnings say "so everyone could be seated" only when everyone is, a group the repair newly
// seated isn't said to have "moved", and renaming a guest never changes the plan (groups of the same
// size go by lowest guest id, not by the guest list's last-name order).
// TS-252: also a mixed-side must-sit family's side, and Fully Mixed leaving a table one-sided.
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateSeatingPlan,
  RULE_WEIGHT_CONFIG_VERSION,
  type EngineGuest,
  type EngineRelationship,
  type EngineTable,
} from "../../../../packages/shared/src/seating-engine";

const guest = (id: string, name: string, headcount: number, extra: Partial<EngineGuest> = {}): EngineGuest => ({
  id,
  name,
  headcount,
  requiresAccessibleTable: false,
  isLocked: false,
  currentTableId: null,
  side: "BOTH",
  tier: "OTHER",
  ageCategory: "ADULT",
  requiredTableId: null,
  ...extra,
});

const table = (id: string, label: string, capacity: number, extra: Partial<EngineTable> = {}): EngineTable => ({
  id,
  label,
  capacity,
  isRestricted: false,
  isAccessible: false,
  isLocked: false,
  singleSideOnly: false,
  purposeCriterion: null,
  ...extra,
});

const rel = (a: string, b: string, type: EngineRelationship["type"]): EngineRelationship => ({
  guestAId: a,
  guestBId: b,
  type,
});

const avoidWarnings = (r: ReturnType<typeof generateSeatingPlan>) =>
  r.warnings.filter((w) => w.includes('"avoid" preference'));

// Item 1, the review's repro: the repair moves Cat next to Bob (whom she avoids) to seat Dan, but
// Eve's party of 6 still can't be seated. It used to say "so everyone could be seated".
test("a repaired plan that still leaves someone unseated says the move made room for more guests", () => {
  const guests = [
    guest("a", "Ann Lee", 1, { isLocked: true, currentTableId: "t0" }),
    guest("b", "Bob Lee", 1),
    guest("c", "Cat Moss", 2),
    guest("d", "Dan Ng", 1),
    guest("e", "Eve Ward", 6),
  ];
  const rels = [rel("a", "b", "MUST_SIT_TOGETHER"), rel("c", "b", "AVOID"), rel("a", "d", "MUST_NOT_SIT_TOGETHER")];
  const result = generateSeatingPlan(guests, rels, [table("t0", "Table 1", 5), table("t1", "Table 2", 2)]);
  assert.deepEqual(result.unassignedGuestIds, ["e"]);
  assert.ok(result.warnings.some((w) => w.startsWith("Couldn't seat guest Eve Ward")));
  const [w] = avoidWarnings(result);
  assert.match(w ?? "", /Cat Moss and Bob Lee .* — one of them was moved there to make room for more guests \(/);
  for (const warning of result.warnings) {
    assert.doesNotMatch(warning, /everyone could be seated/);
    assert.doesNotMatch(warning, /\u0000/);
  }
});

// Item 1: G1 had no seat before the repair, so they weren't "moved" anywhere -- they only got a
// seat once seats were rearranged. Everyone is seated here, so "so everyone could be seated" is true.
test("a group the repair newly seated only got a seat; it isn't said to have moved", () => {
  const guests = [guest("g0", "G0", 2), guest("g1", "G1", 1), guest("g2", "G2", 2)];
  const rels = [rel("g0", "g1", "AVOID"), rel("g1", "g2", "MUST_NOT_SIT_TOGETHER")];
  const result = generateSeatingPlan(guests, rels, [table("T1", "Table 1", 2), table("T2", "Table 2", 3)]);
  assert.equal(result.isComplete, true);
  const [w] = avoidWarnings(result);
  assert.match(w ?? "", /G1 and G0 .* — one of them only got a seat when seats were rearranged so everyone could be seated \(/);
  assert.doesNotMatch(w ?? "", /moved there/);
});

// Item 1: neither G1 nor G3 moved in the repair (only G2 did), so it doesn't say one of them moved
// or that "seats were rearranged" put them together.
test("an avoid pair that neither moved says neither of them was moved", () => {
  const guests = [guest("g0", "G0", 1), guest("g1", "G1", 1), guest("g2", "G2", 1), guest("g3", "G3", 1)];
  const rels = [rel("g1", "g3", "AVOID"), rel("g1", "g2", "MUST_NOT_SIT_TOGETHER")];
  const result = generateSeatingPlan(guests, rels, [table("T1", "Table 1", 4), table("T2", "Table 2", 1)]);
  assert.equal(result.isComplete, true);
  const [w] = avoidWarnings(result);
  assert.match(w ?? "", /G3 and G1 .* — neither of them was moved when seats were rearranged so everyone could be seated \(/);
});

test("the weighting version is 9", () => {
  assert.equal(RULE_WEIGHT_CONFIG_VERSION, 9);
});

// Item 2: two singles compete for the last seat. Before, the one earlier in the guest list (by last
// name) won, so renaming "Zed Young" to "Abe Adams" gave him the seat. Now the lower guest id wins.
test("of two same-size groups, the lower guest id is seated first, whatever their names", () => {
  const tables = [table("T1", "Table 1", 1)];
  const run = (names: [string, string]) => {
    // The server sends guests by last name, first name, id.
    const guests = [guest("id-2", names[0], 1), guest("id-1", names[1], 1)].sort((a, b) =>
      lastFirst(a).localeCompare(lastFirst(b))
    );
    return generateSeatingPlan(guests, [], tables);
  };
  for (const names of [
    ["Ann Adams", "Zed Young"],
    ["Ann Adams", "Abe Aaron"],
  ] as [string, string][]) {
    const result = run(names);
    assert.deepEqual(result.assignments, [{ guestId: "id-1", tableId: "T1" }], names.join(" / "));
    assert.deepEqual(result.unassignedGuestIds, ["id-2"]);
  }
});

const lastFirst = (g: EngineGuest) => {
  const [first, ...rest] = g.name.split(" ");
  return `${rest.join(" ")}\u0001${first}\u0001${g.id}`;
};

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Item 2, the property: random tight weddings (locks, locked and Restricted tables, accessible needs,
// must / must-not rules, soft preferences). Renaming one guest -- and re-sorting the list the way the
// server does (last name, first name, id) -- must never change who sits where, or who's unseated.
test("3,000 random weddings: renaming a guest never changes the plan", () => {
  const rnd = mulberry32(244);
  const ri = (n: number) => Math.floor(rnd() * n);
  const pick = <T,>(a: readonly T[]) => a[ri(a.length)];
  const FIRST = ["Ann", "Ben", "Cat", "Dan", "Eve", "Fay", "Gus", "Hal"];
  const LAST = ["Adams", "Baker", "Clark", "Davis", "Evans", "Ford", "Green", "Hall"];
  const plan = (r: ReturnType<typeof generateSeatingPlan>) => ({
    seats: [...r.assignments].map((a) => `${a.guestId}@${a.tableId}`).sort(),
    unseated: [...r.unassignedGuestIds].sort(),
    errors: r.errors.length,
  });
  let changedOrder = 0;
  for (let iter = 0; iter < 3000; iter++) {
    const tables: EngineTable[] = [];
    const nt = 1 + ri(5);
    for (let i = 0; i < nt; i++) {
      tables.push(
        table(`T${i}`, `Table ${i}`, 1 + ri(6), {
          isRestricted: rnd() < 0.1,
          isAccessible: rnd() < 0.35,
          isLocked: rnd() < 0.15,
          singleSideOnly: rnd() < 0.15,
        })
      );
    }
    const guests: EngineGuest[] = [];
    const ng = 2 + ri(14);
    for (let i = 0; i < ng; i++) {
      guests.push(
        guest(`G${String(i).padStart(2, "0")}`, `${pick(FIRST)} ${pick(LAST)}`, 1 + ri(3), {
          requiresAccessibleTable: rnd() < 0.2,
          isLocked: rnd() < 0.15,
          currentTableId: rnd() < 0.3 ? pick(tables).id : null,
          side: pick(["BRIDE", "GROOM", "BOTH"] as const),
        })
      );
    }
    for (const t of tables.filter((t) => t.isRestricted)) {
      for (const g of guests) if (!g.requiredTableId && rnd() < 0.2) g.requiredTableId = t.id;
    }
    const rels: EngineRelationship[] = [];
    const nr = ri(8);
    for (let i = 0; i < nr; i++) {
      const a = pick(guests).id;
      const b = pick(guests).id;
      if (a !== b) rels.push(rel(a, b, pick(["MUST_SIT_TOGETHER", "MUST_NOT_SIT_TOGETHER", "PREFER_NEAR", "AVOID"] as const)));
    }
    const mix = pick(["KEEP_SEPARATE", "BALANCED_MIX", "FULLY_MIXED"] as const);
    const sorted = (list: EngineGuest[]) => [...list].sort((a, b) => lastFirst(a).localeCompare(lastFirst(b)));

    const before = sorted(guests);
    const renamedIndex = ri(guests.length);
    const after = sorted(
      guests.map((g, i) => (i === renamedIndex ? { ...g, name: `${pick(FIRST)} ${pick(["Aaron", "Zane", ...LAST])}` } : g))
    );
    if (before.map((g) => g.id).join() !== after.map((g) => g.id).join()) changedOrder++;
    const input = JSON.stringify({ before, after, rels, tables, mix });
    assert.deepEqual(
      plan(generateSeatingPlan(after, rels, tables, mix)),
      plan(generateSeatingPlan(before, rels, tables, mix)),
      `renaming changed the plan: ${input}`
    );
  }
  // The rename really did reorder the guest list in a good share of the weddings.
  assert.ok(changedOrder > 500, `only ${changedOrder} renames reordered the list`);
});

// TS-247: Fully Mixed spreads each side over the tables whatever order the guests come in -- it
// used to leave one table with a single side in about two orders out of three.
test("Fully Mixed mixes every table for any processing order (TS-247)", () => {
  const sides = ["BRIDE", "BRIDE", "GROOM", "GROOM", "BOTH"] as const;
  const perms: number[][] = [];
  const permute = (rest: number[], acc: number[]) => {
    if (rest.length === 0) return void perms.push(acc);
    rest.forEach((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
  };
  permute([0, 1, 2, 3, 4], []);
  for (const order of perms) {
    // ids decide the order for same-size groups (TS-244), so give them in this permutation's order
    const guests = order.map((k, rank) => guest(`g${rank}-${k}`, `Guest ${k}`, 1, { side: sides[k] }));
    const result = generateSeatingPlan(guests, [], [table("A", "A", 4), table("B", "B", 4)], "FULLY_MIXED");
    assert.equal(result.scoreReport?.sideMixing.mixedTableCount, 2, `order ${order.join(",")}`);
  }
});

// TS-252: a must-sit family of Bride, Groom and Bride guests counts as Both whatever order they're
// listed in. Before, the side was folded in list (last-name) order -- Bride, Groom, Bride came out
// Bride but Bride, Bride, Groom came out Both -- so renaming Cy Clark to Cy Abbot moved the family
// to the other table under Keep Separate.
test("renaming one of a mixed-side family never changes the plan under Keep Separate (TS-252)", () => {
  const tables = [table("t1", "Table 1", 7), table("t2", "Table 2", 7)];
  const rels = [rel("a", "b", "MUST_SIT_TOGETHER"), rel("b", "c", "MUST_SIT_TOGETHER")];
  const others = [guest("x", "Xavier Young", 4, { side: "GROOM" }), guest("y", "Yolanda York", 4, { side: "BRIDE" })];
  const sorted = (list: EngineGuest[]) => [...list].sort((p, q) => lastFirst(p).localeCompare(lastFirst(q)));
  const seats = (r: ReturnType<typeof generateSeatingPlan>) => r.assignments.map((a) => `${a.guestId}@${a.tableId}`).sort();
  const run = (cName: string) =>
    generateSeatingPlan(
      sorted([
        guest("a", "Ann Adams", 1, { side: "BRIDE" }),
        guest("b", "Bob Baker", 1, { side: "GROOM" }),
        guest("c", cName, 1, { side: "BRIDE" }),
        ...others,
      ]),
      rels,
      tables,
      "KEEP_SEPARATE"
    );
  const before = run("Cy Clark"); // listed Bride, Groom, Bride
  const after = run("Cy Abbot"); // listed Bride, Bride, Groom
  assert.equal(before.isComplete, true);
  assert.deepEqual(seats(after), seats(before));

  // And every listing order of the family gives the same plan, under every setting.
  const family = [
    guest("a", "A", 1, { side: "BRIDE" }),
    guest("b", "B", 1, { side: "GROOM" }),
    guest("c", "C", 1, { side: "BRIDE" }),
  ];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const mix of ["KEEP_SEPARATE", "BALANCED_MIX", "FULLY_MIXED"] as const) {
    const plans = orders.map((o) => seats(generateSeatingPlan([...o.map((i) => family[i]), ...others], rels, tables, mix)));
    for (const p of plans) assert.deepEqual(p, plans[0], mix);
  }
});

// TS-252, the review's repro: under Fully Mixed, the second Bride guest went to Table 1 for its
// many Groom guests (the other-side bonus was counted per guest) instead of Table 2, which had no
// Bride guest yet -- leaving Table 2 Groom-only though both tables could have been mixed.
test("Fully Mixed prefers a table with nobody from a guest's side over one with many of the other side (TS-252)", () => {
  const guests = [
    guest("a", "a", 2, { side: "GROOM" }),
    guest("b", "b", 2, { side: "GROOM" }),
    guest("c", "c", 1, { side: "BRIDE" }),
    guest("d", "d", 1, { side: "GROOM" }),
    guest("e", "e", 1, { side: "GROOM" }),
    guest("f", "f", 1, { side: "BRIDE" }),
  ];
  const result = generateSeatingPlan(guests, [], [table("T1", "Table 1", 6), table("T2", "Table 2", 6)], "FULLY_MIXED");
  const tableOf = (id: string) => result.assignments.find((a) => a.guestId === id)?.tableId ?? null;
  assert.equal(result.isComplete, true);
  assert.equal(result.scoreReport?.sideMixing.mixedTableCount, 2);
  assert.equal(result.scoreReport?.sideMixing.singleSideTableCount, 0);
  assert.notEqual(tableOf("c"), tableOf("f"));
});
