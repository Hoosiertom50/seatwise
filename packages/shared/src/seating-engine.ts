// Automated seat assignment engine (FR-8 / TS-8).
//
// This is a pure function over plain data — no database access — so it can be unit tested on
// its own and reused wherever a seating plan needs to be computed or previewed.
//
// Design, matching the Cross-Cutting Rule invariant (FR-0.1 / FR-0.2):
//   - Hard rules (must sit together, must not sit together, requires an accessible table,
//     table capacity) are NEVER violated. If honoring them all is impossible, the affected
//     guests are left unassigned and the plan is marked incomplete — never silently broken.
//   - A genuine hard-rule contradiction (e.g. A and B are forced together by a chain of
//     "must sit together" rules, but also have a direct "must not sit together" rule) blocks
//     generation entirely with a clear error, rather than guessing.
//   - Soft rules (prefer near / avoid) are scored best-effort and never block a placement;
//     when one can't be honored, it's surfaced as a non-blocking warning.
//   - Restricted tables (a specific required guest list) are excluded from automatic
//     assignment for now — the schema tracks "isRestricted" but not yet a per-table required
//     list, so those tables are reserved for manual assignment (a later story).

export type EngineRelationshipType =
  | "MUST_SIT_TOGETHER"
  | "MUST_NOT_SIT_TOGETHER"
  | "PREFER_NEAR"
  | "AVOID";

export interface EngineGuest {
  id: string;
  name: string;
  headcount: number;
  requiresAccessibleTable: boolean;
}

export interface EngineRelationship {
  guestAId: string;
  guestBId: string;
  type: EngineRelationshipType;
}

export interface EngineTable {
  id: string;
  capacity: number;
  isRestricted: boolean;
  isAccessible: boolean;
}

export interface SeatingPlanAssignment {
  guestId: string;
  tableId: string;
}

export interface SeatingPlanResult {
  assignments: SeatingPlanAssignment[];
  unassignedGuestIds: string[];
  warnings: string[];
  errors: string[];
  isComplete: boolean;
}

interface Unit {
  guestIds: string[];
  totalHeadcount: number;
  requiresAccessible: boolean;
}

class UnionFind {
  private parent = new Map<string, string>();

  add(id: string) {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const p = this.parent.get(id);
    if (p === undefined) throw new Error(`Unknown id in union-find: ${id}`);
    if (p === id) return id;
    const root = this.find(p);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function generateSeatingPlan(
  guests: EngineGuest[],
  relationships: EngineRelationship[],
  tables: EngineTable[]
): SeatingPlanResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const guestById = new Map(guests.map((g) => [g.id, g]));
  const guestName = (id: string) => guestById.get(id)?.name ?? id;

  // 1. Group guests forced together by MUST_SIT_TOGETHER into units.
  const uf = new UnionFind();
  for (const g of guests) uf.add(g.id);
  for (const r of relationships) {
    if (r.type === "MUST_SIT_TOGETHER") uf.union(r.guestAId, r.guestBId);
  }

  // 2. A MUST_NOT_SIT_TOGETHER pair that ends up in the same forced unit is an unresolvable
  // hard-rule contradiction — refuse to generate rather than silently pick a side.
  for (const r of relationships) {
    if (r.type === "MUST_NOT_SIT_TOGETHER" && uf.find(r.guestAId) === uf.find(r.guestBId)) {
      errors.push(
        `Guests ${guestName(r.guestAId)} and ${guestName(r.guestBId)} are forced to the same ` +
          `table by "must sit together" rules, but also have a "must not sit together" rule ` +
          `between them. Fix that conflict before generating a plan.`
      );
    }
  }
  if (errors.length > 0) {
    return { assignments: [], unassignedGuestIds: guests.map((g) => g.id), warnings, errors, isComplete: false };
  }

  const unitsByRoot = new Map<string, Unit>();
  for (const g of guests) {
    const root = uf.find(g.id);
    let unit = unitsByRoot.get(root);
    if (!unit) {
      unit = { guestIds: [], totalHeadcount: 0, requiresAccessible: false };
      unitsByRoot.set(root, unit);
    }
    unit.guestIds.push(g.id);
    unit.totalHeadcount += g.headcount;
    if (g.requiresAccessibleTable) unit.requiresAccessible = true;
  }
  const units = [...unitsByRoot.values()];

  // AVOID / PREFER_NEAR / MUST_NOT_SIT_TOGETHER lookups, keyed by guest id -> set of guest ids.
  // MUST_NOT_SIT_TOGETHER is a hard rule: two guests can end up in *different* seating units
  // (no MUST_SIT_TOGETHER chain forces them together) and still each have somewhere to sit —
  // just never at the same table as each other. That has to be enforced at table-selection
  // time, not just as a same-unit contradiction check above.
  const avoidMap = new Map<string, Set<string>>();
  const preferMap = new Map<string, Set<string>>();
  const mustNotMap = new Map<string, Set<string>>();
  function addToMap(map: Map<string, Set<string>>, a: string, b: string) {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a)!.add(b);
  }
  for (const r of relationships) {
    if (r.type === "AVOID") {
      addToMap(avoidMap, r.guestAId, r.guestBId);
      addToMap(avoidMap, r.guestBId, r.guestAId);
    } else if (r.type === "PREFER_NEAR") {
      addToMap(preferMap, r.guestAId, r.guestBId);
      addToMap(preferMap, r.guestBId, r.guestAId);
    } else if (r.type === "MUST_NOT_SIT_TOGETHER") {
      addToMap(mustNotMap, r.guestAId, r.guestBId);
      addToMap(mustNotMap, r.guestBId, r.guestAId);
    }
  }

  // 3. Bin-pack units into tables, largest unit first (first-fit-decreasing), restricted
  // tables excluded from the automatic pool.
  const candidateTables = tables.filter((t) => !t.isRestricted);
  const remainingCapacity = new Map(candidateTables.map((t) => [t.id, t.capacity]));
  const occupants = new Map<string, string[]>(candidateTables.map((t) => [t.id, []]));

  const sortedUnits = [...units].sort((a, b) => b.totalHeadcount - a.totalHeadcount);
  const assignments: SeatingPlanAssignment[] = [];
  const unassignedGuestIds: string[] = [];

  for (const unit of sortedUnits) {
    const hasMustNotConflict = (t: string) =>
      occupants.get(t)!.some((occupantId) =>
        unit.guestIds.some((guestId) => mustNotMap.get(guestId)?.has(occupantId))
      );

    const capacityFeasible = candidateTables.filter((t) => {
      if ((remainingCapacity.get(t.id) ?? 0) < unit.totalHeadcount) return false;
      if (unit.requiresAccessible && !t.isAccessible) return false;
      return true;
    });
    // MUST_NOT_SIT_TOGETHER is a hard rule: never seat this unit at a table that already
    // holds someone they must not sit with, even if capacity and accessibility both allow it.
    const feasible = capacityFeasible.filter((t) => !hasMustNotConflict(t.id));

    if (feasible.length === 0) {
      unassignedGuestIds.push(...unit.guestIds);
      let reason: string;
      if (capacityFeasible.length === 0) {
        reason = unit.requiresAccessible
          ? "no accessible table has enough remaining capacity"
          : "no table has enough remaining capacity";
      } else {
        reason =
          "every table with enough remaining capacity already seats someone they have a " +
          '"must not sit together" rule with';
      }
      warnings.push(
        `Couldn't seat ${unit.guestIds.length === 1 ? "guest" : "guests"} ${unit.guestIds
          .map(guestName)
          .join(", ")} — ${reason}.`
      );
      continue;
    }

    // Score each feasible table: fewer AVOID conflicts and more PREFER_NEAR satisfactions is
    // better; tie-break toward the tightest fit (least leftover capacity) to reduce
    // fragmentation.
    let best = feasible[0];
    let bestScore = -Infinity;
    for (const t of feasible) {
      const existing = occupants.get(t.id)!;
      let avoidHits = 0;
      let preferHits = 0;
      for (const guestId of unit.guestIds) {
        for (const other of existing) {
          if (avoidMap.get(guestId)?.has(other)) avoidHits++;
          if (preferMap.get(guestId)?.has(other)) preferHits++;
        }
      }
      const leftover = (remainingCapacity.get(t.id) ?? 0) - unit.totalHeadcount;
      const score = preferHits * 10 - avoidHits * 10 - leftover * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }

    for (const guestId of unit.guestIds) {
      assignments.push({ guestId, tableId: best.id });
    }
    remainingCapacity.set(best.id, (remainingCapacity.get(best.id) ?? 0) - unit.totalHeadcount);
    occupants.get(best.id)!.push(...unit.guestIds);

    // Surface any AVOID conflicts this placement couldn't avoid (soft rule — non-blocking).
    const existing = occupants.get(best.id)!.filter((id) => !unit.guestIds.includes(id));
    for (const guestId of unit.guestIds) {
      for (const other of existing) {
        if (avoidMap.get(guestId)?.has(other)) {
          warnings.push(
            `${guestName(guestId)} and ${guestName(other)} were seated at the same table ` +
              `despite an "avoid" preference between them — no other table had room.`
          );
        }
      }
    }
  }

  return {
    assignments,
    unassignedGuestIds,
    warnings,
    errors,
    isComplete: unassignedGuestIds.length === 0,
  };
}
