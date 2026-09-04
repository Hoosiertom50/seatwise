// Automated seat assignment engine (FR-8 / TS-8, extended for locks in TS-10 / FR-7.4).
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
//   - Locked guests (FR-7.4) keep their current table when regenerating rather than being
//     reshuffled, and locked tables are reserved — excluded from the general candidate pool —
//     so automatic generation doesn't fill them with new guests. If a lock can no longer be
//     honored (the table's gone, or honoring it would break a hard rule), the affected guests
//     fall back to normal automatic placement with a warning explaining why, rather than being
//     left unassigned just because a stale lock couldn't be kept.

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
  // FR-7.4: if locked and currently seated somewhere, generation tries to keep them there.
  isLocked: boolean;
  currentTableId?: string | null;
}

export interface EngineRelationship {
  guestAId: string;
  guestBId: string;
  type: EngineRelationshipType;
}

export interface EngineTable {
  id: string;
  label: string;
  capacity: number;
  isRestricted: boolean;
  isAccessible: boolean;
  isLocked: boolean;
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
  pinnedTableId: string | null;
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
  const tablesById = new Map(tables.map((t) => [t.id, t]));

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
      unit = { guestIds: [], totalHeadcount: 0, requiresAccessible: false, pinnedTableId: null };
      unitsByRoot.set(root, unit);
    }
    unit.guestIds.push(g.id);
    unit.totalHeadcount += g.headcount;
    if (g.requiresAccessibleTable) unit.requiresAccessible = true;
    // FR-7.4: if any locked guest in this unit has a current table, pin the whole unit there.
    // (Unit members are always seated together, so one locked member's table is the unit's.)
    if (g.isLocked && g.currentTableId && !unit.pinnedTableId) {
      unit.pinnedTableId = g.currentTableId;
    }
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

  // 3. Bin-pack units into tables, largest unit first (first-fit-decreasing). Restricted and
  // locked tables are excluded from the *general* candidate pool — locked tables are reserved,
  // restricted tables need manual assignment (TS-8 scoping) — but a unit pinned to one of them
  // by a lock can still land there; capacity/occupancy tracking covers every table so a pin can
  // target any of them.
  const candidateTables = tables.filter((t) => !t.isRestricted && !t.isLocked);
  const remainingCapacity = new Map(tables.map((t) => [t.id, t.capacity]));
  const occupants = new Map<string, string[]>(tables.map((t) => [t.id, []]));

  const hasMustNotConflict = (unit: Unit, tableId: string) =>
    occupants.get(tableId)!.some((occupantId) =>
      unit.guestIds.some((guestId) => mustNotMap.get(guestId)?.has(occupantId))
    );

  // Attempts to place `unit` at the best of `pool`; returns the chosen table, or null if no
  // table in `pool` can hold it without breaking a hard rule. Mutates remainingCapacity/
  // occupants/assignments/warnings only on success.
  function attemptPlace(unit: Unit, pool: EngineTable[]): EngineTable | null {
    const capacityFeasible = pool.filter((t) => {
      if ((remainingCapacity.get(t.id) ?? 0) < unit.totalHeadcount) return false;
      if (unit.requiresAccessible && !t.isAccessible) return false;
      return true;
    });
    const feasible = capacityFeasible.filter((t) => !hasMustNotConflict(unit, t.id));
    if (feasible.length === 0) return null;

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
    const existingBefore = [...occupants.get(best.id)!];
    occupants.get(best.id)!.push(...unit.guestIds);

    // Surface any AVOID conflicts this placement couldn't avoid (soft rule — non-blocking).
    for (const guestId of unit.guestIds) {
      for (const other of existingBefore) {
        if (avoidMap.get(guestId)?.has(other)) {
          warnings.push(
            `${guestName(guestId)} and ${guestName(other)} were seated at the same table ` +
              `despite an "avoid" preference between them — no other table had room.`
          );
        }
      }
    }
    return best;
  }

  function unassignedReason(unit: Unit): string {
    const capacityFeasible = candidateTables.filter((t) => {
      if ((remainingCapacity.get(t.id) ?? 0) < unit.totalHeadcount) return false;
      if (unit.requiresAccessible && !t.isAccessible) return false;
      return true;
    });
    if (capacityFeasible.length === 0) {
      return unit.requiresAccessible
        ? "no accessible table has enough remaining capacity"
        : "no table has enough remaining capacity";
    }
    return (
      "every table with enough remaining capacity already seats someone they have a " +
      '"must not sit together" rule with'
    );
  }

  // Pinned (locked) units are placed first, so their reserved capacity isn't grabbed by other
  // units first; unpinned units then follow the existing largest-first heuristic.
  const pinnedUnits = units.filter((u) => u.pinnedTableId);
  const unpinnedUnits = [...units.filter((u) => !u.pinnedTableId)].sort(
    (a, b) => b.totalHeadcount - a.totalHeadcount
  );

  const assignments: SeatingPlanAssignment[] = [];
  const unassignedGuestIds: string[] = [];

  for (const unit of pinnedUnits) {
    const target = unit.pinnedTableId ? tablesById.get(unit.pinnedTableId) : undefined;
    const placedAt = target ? attemptPlace(unit, [target]) : null;
    if (placedAt) continue;

    // The lock couldn't be honored (table deleted, or it would now break a hard rule) — fall
    // back to normal automatic placement rather than leaving a locked guest stranded just
    // because their specific pin is no longer possible.
    warnings.push(
      `${unit.guestIds.length === 1 ? "Guest" : "Guests"} ${unit.guestIds
        .map(guestName)
        .join(", ")} ${unit.guestIds.length === 1 ? "is" : "are"} locked to ` +
        `${target ? `"${target.label}"` : "a table that no longer exists"}, but that's no ` +
        `longer possible — seated automatically instead.`
    );
    const fallback = attemptPlace(unit, candidateTables);
    if (!fallback) {
      unassignedGuestIds.push(...unit.guestIds);
      warnings.push(
        `Couldn't seat ${unit.guestIds.length === 1 ? "guest" : "guests"} ${unit.guestIds
          .map(guestName)
          .join(", ")} — ${unassignedReason(unit)}.`
      );
    }
  }

  for (const unit of unpinnedUnits) {
    const placedAt = attemptPlace(unit, candidateTables);
    if (!placedAt) {
      unassignedGuestIds.push(...unit.guestIds);
      warnings.push(
        `Couldn't seat ${unit.guestIds.length === 1 ? "guest" : "guests"} ${unit.guestIds
          .map(guestName)
          .join(", ")} — ${unassignedReason(unit)}.`
      );
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
