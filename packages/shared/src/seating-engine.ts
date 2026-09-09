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
//   - A Purpose table's structured criterion (FR-3.7 — Side, Relationship Tier, or Age Category)
//     is a soft preference like prefer-near/avoid: it nudges a matching guest toward that table
//     but never blocks a non-matching guest from being seated there, and overflow beyond the
//     table's capacity is simply placed elsewhere rather than failing generation.

export type EngineRelationshipType =
  | "MUST_SIT_TOGETHER"
  | "MUST_NOT_SIT_TOGETHER"
  | "PREFER_NEAR"
  | "AVOID";

// FR-3.4: which side of the wedding a guest belongs to. BOTH never counts toward either side.
export type EngineGuestSide = "BRIDE" | "GROOM" | "BOTH";

// FR-3.7: a guest's relationship tier -- read here only for a Purpose table's TIER criterion;
// never otherwise scored.
export type EngineGuestTier = "VIP" | "FAMILY" | "FRIEND" | "PLUS_ONE" | "OTHER";

// FR-3.7: lets a Purpose table's Age Category criterion (e.g. "Kids' Table") mean something.
export type EngineAgeCategory = "ADULT" | "CHILD" | "INFANT";

// FR-3.4: how much generation weights table composition toward mixing the two sides. Always a
// soft preference (see the side-mixing scoring in attemptPlace below) -- never a hard rule.
export type EngineSideMixing = "KEEP_SEPARATE" | "BALANCED_MIX" | "FULLY_MIXED";

export interface EngineGuest {
  id: string;
  name: string;
  headcount: number;
  requiresAccessibleTable: boolean;
  // FR-7.4: if locked and currently seated somewhere, generation tries to keep them there.
  isLocked: boolean;
  currentTableId?: string | null;
  // FR-3.4
  side: EngineGuestSide;
  // FR-3.7: read only for a Purpose table's TIER/AGE_CATEGORY criterion.
  tier: EngineGuestTier;
  ageCategory: EngineAgeCategory;
  // FR-3.7a: set when this guest is on a Restricted table's required-guest list -- a hard pin,
  // stronger than a lock (a lock falls back gracefully if it can't be honored; a required-table
  // guest is only ever supposed to reach generation already validated to fit, but the same
  // graceful-fallback path is reused defensively if the table shrank since the list was saved).
  requiredTableId?: string | null;
}

// FR-3.7: a Purpose table's structured criterion -- a soft preference only; a non-matching guest
// can still be seated there when needed (it's never part of hard-rule feasibility filtering).
export type EnginePurposeCriterionType = "SIDE" | "TIER" | "AGE_CATEGORY";
export interface EnginePurposeCriterion {
  type: EnginePurposeCriterionType;
  value: string;
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
  // FR-3.4: a table-level override favoring one side only, regardless of the wedding's overall
  // Side-Mixing setting. Still just a soft preference.
  singleSideOnly: boolean;
  // FR-3.7: this table's structured Purpose criterion, if any -- a soft preference (see
  // attemptPlace's scoring below), never a factor in hard-rule feasibility.
  purposeCriterion?: EnginePurposeCriterion | null;
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
  // FR-5.3: which soft preferences were satisfied/unsatisfied by the final plan, the weighting-
  // configuration version that produced it, and an approximate total score using those same
  // weights -- omitted on a hard-rule-contradiction failure (errors.length > 0), since no plan
  // was actually produced to score.
  scoreReport?: SoftPreferenceScoreReport;
}

// FR-5.3: one PREFER_NEAR or AVOID relationship's outcome in the final plan.
export interface SoftPreferenceEntry {
  type: "PREFER_NEAR" | "AVOID";
  guestAId: string;
  guestAName: string;
  guestBId: string;
  guestBName: string;
  // PREFER_NEAR: satisfied means seated at the same table. AVOID: satisfied means seated at
  // different tables (or one/both unseated, which trivially avoids sitting together).
  satisfied: boolean;
}

// FR-3.7/FR-5.3: a Purpose table's structured criterion is a wedding-wide preference, not a
// single pairwise one -- reported as how many matching guests (across the whole wedding) actually
// ended up seated at this table versus how many matching guests exist at all.
export interface PurposeTableScoreEntry {
  tableId: string;
  tableLabel: string;
  criterionType: EnginePurposeCriterionType;
  criterionValue: string;
  matchingGuestsSeatedHere: number;
  matchingGuestsTotal: number;
}

// FR-3.4/FR-5.3: Side-Mixing (and its Single-Side-Only table override) is scored per table, not
// per guest pair, so it's reported as an aggregate rather than a list of individual preferences.
export interface SideMixingScoreReport {
  setting: EngineSideMixing;
  // Tables seating guests from both sides.
  mixedTableCount: number;
  // Multi-occupant tables seating only one side.
  singleSideTableCount: number;
  // Single-Side-Only tables that nonetheless ended up seating both sides.
  singleSideOnlyViolations: number;
}

export interface SoftPreferenceScoreReport {
  ruleConfigVersion: number;
  // An approximate summary using the same documented weights (RULE_WEIGHT_CONFIG) the live
  // placement scoring uses -- FR-5.3 explicitly doesn't require the plan itself to be
  // mathematically optimal, and this total is likewise a best-effort summary, not a claim that a
  // higher score was unreachable. See RULE_WEIGHT_CONFIG below for exactly how each term is
  // weighted -- that's this score's calculation method.
  totalScore: number;
  preferences: SoftPreferenceEntry[];
  purposeTables: PurposeTableScoreEntry[];
  sideMixing: SideMixingScoreReport;
}

interface Unit {
  guestIds: string[];
  totalHeadcount: number;
  requiresAccessible: boolean;
  pinnedTableId: string | null;
  pinReason: "lock" | "required" | null;
  // FR-3.4: BRIDE/GROOM if every non-BOTH member of the unit agrees; BOTH if the unit is all BOTH
  // guests, or mixes BRIDE and GROOM members (a forced-together group already overrides any
  // side-mixing preference for its own members, so it's neutral for scoring purposes).
  side: EngineGuestSide;
}

// FR-0.2 / FR-3.4 / FR-3.7: the soft-rule weighting constants below, versioned. Bump the version
// whenever these numbers (or the formula that uses them) change, so a Plan Version's stored
// ruleConfigVersion always identifies exactly what produced it (FR-3.4's acceptance criterion).
export const RULE_WEIGHT_CONFIG_VERSION = 2;
export const RULE_WEIGHT_CONFIG = {
  preferNearBonus: 10,
  avoidPenalty: 10,
  leftoverCapacityWeight: 0.01,
  sideMixing: {
    keepSeparateOppositeSidePenalty: 8,
    balancedMixOppositeSideBonus: 3,
    fullyMixedOppositeSideBonus: 8,
    singleSideOnlyMismatchPenalty: 6,
  },
  // FR-3.7: a bonus per unit member matching a Purpose table's structured criterion -- meaningful
  // enough to steer placement toward that table, but (unlike a hard rule) never a requirement.
  // The mismatch penalty is deliberately small (a third of the bonus): without it, a small
  // Purpose table's plain leftover-capacity tie-break alone would make it look attractive to
  // *any* guest regardless of match (smaller tables always "win" that tie-break), quietly
  // defeating "the criterion favors children" by letting non-matching guests fill it first.
  purposeCriterionBonus: 6,
  purposeCriterionMismatchPenalty: 2,
} as const;

// FR-5.3: a pure post-analysis pass over the final assignments -- deliberately decoupled from
// attemptPlace's own (local, per-decision) scoring above, so adding this reporting can never
// change what generation actually does, only what it reports afterward.
function computeScoreReport(
  guests: EngineGuest[],
  relationships: EngineRelationship[],
  tables: EngineTable[],
  sideMixing: EngineSideMixing,
  assignments: SeatingPlanAssignment[]
): SoftPreferenceScoreReport {
  const guestById = new Map(guests.map((g) => [g.id, g]));
  const guestName = (id: string) => guestById.get(id)?.name ?? id;
  const tableIdByGuestId = new Map(assignments.map((a) => [a.guestId, a.tableId]));
  const w = RULE_WEIGHT_CONFIG;

  let totalScore = 0;

  // PREFER_NEAR / AVOID: one entry per relationship, deduplicated in case the same pair somehow
  // appears twice (relationships are meant to be unique per pair+type, but this stays correct
  // either way rather than double-counting).
  const preferences: SoftPreferenceEntry[] = [];
  const seenPairs = new Set<string>();
  for (const r of relationships) {
    if (r.type !== "PREFER_NEAR" && r.type !== "AVOID") continue;
    const pairKey = `${r.type}::${[r.guestAId, r.guestBId].sort().join("::")}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const tableA = tableIdByGuestId.get(r.guestAId);
    const tableB = tableIdByGuestId.get(r.guestBId);
    const seatedTogether = tableA !== undefined && tableA === tableB;
    const satisfied = r.type === "PREFER_NEAR" ? seatedTogether : !seatedTogether;
    if (r.type === "PREFER_NEAR" && satisfied) totalScore += w.preferNearBonus;
    if (r.type === "AVOID" && !satisfied) totalScore -= w.avoidPenalty;

    preferences.push({
      type: r.type,
      guestAId: r.guestAId,
      guestAName: guestName(r.guestAId),
      guestBId: r.guestBId,
      guestBName: guestName(r.guestBId),
      satisfied,
    });
  }

  // Purpose-table criterion (FR-3.7): wedding-wide match rate per Purpose table.
  const purposeTables: PurposeTableScoreEntry[] = [];
  for (const t of tables) {
    if (!t.purposeCriterion) continue;
    const { type, value } = t.purposeCriterion;
    let matchingGuestsTotal = 0;
    let matchingGuestsSeatedHere = 0;
    for (const g of guests) {
      const fieldValue = type === "SIDE" ? g.side : type === "TIER" ? g.tier : g.ageCategory;
      if (fieldValue !== value) continue;
      matchingGuestsTotal++;
      if (tableIdByGuestId.get(g.id) === t.id) {
        matchingGuestsSeatedHere++;
        totalScore += w.purposeCriterionBonus;
      }
    }
    purposeTables.push({
      tableId: t.id,
      tableLabel: t.label,
      criterionType: type,
      criterionValue: value,
      matchingGuestsSeatedHere,
      matchingGuestsTotal,
    });
  }

  // Side-Mixing (FR-3.4): an aggregate view, not a per-pair list -- occupancy at each table that
  // ended up with 2+ guests is classified as mixed (both sides present) or single-side, and every
  // Single-Side-Only table that nonetheless ended up mixed is counted as a violation (mirroring
  // the same non-blocking warning already surfaced during generation for that case).
  const occupantsByTable = new Map<string, string[]>();
  for (const a of assignments) {
    if (!occupantsByTable.has(a.tableId)) occupantsByTable.set(a.tableId, []);
    occupantsByTable.get(a.tableId)!.push(a.guestId);
  }
  const tablesById = new Map(tables.map((t) => [t.id, t]));
  let mixedTableCount = 0;
  let singleSideTableCount = 0;
  let singleSideOnlyViolations = 0;
  for (const [tableId, occupantIds] of occupantsByTable) {
    let bride = 0;
    let groom = 0;
    for (const guestId of occupantIds) {
      const side = guestById.get(guestId)?.side;
      if (side === "BRIDE") bride++;
      else if (side === "GROOM") groom++;
    }
    const isMixed = bride > 0 && groom > 0;
    if (isMixed) {
      mixedTableCount++;
      // Mixing is the desired outcome under Balanced/Fully Mixed, and the thing Keep Separate
      // specifically tries to avoid.
      if (sideMixing === "KEEP_SEPARATE") {
        totalScore -= w.sideMixing.keepSeparateOppositeSidePenalty;
      } else if (sideMixing === "FULLY_MIXED") {
        totalScore += w.sideMixing.fullyMixedOppositeSideBonus;
      } else {
        totalScore += w.sideMixing.balancedMixOppositeSideBonus;
      }
    } else if (bride > 0 || groom > 0) {
      singleSideTableCount++;
    }
    if (isMixed && tablesById.get(tableId)?.singleSideOnly) {
      singleSideOnlyViolations++;
      totalScore -= w.sideMixing.singleSideOnlyMismatchPenalty;
    }
  }

  return {
    ruleConfigVersion: RULE_WEIGHT_CONFIG_VERSION,
    totalScore,
    preferences,
    purposeTables,
    sideMixing: { setting: sideMixing, mixedTableCount, singleSideTableCount, singleSideOnlyViolations },
  };
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
  tables: EngineTable[],
  sideMixing: EngineSideMixing = "BALANCED_MIX"
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
      unit = {
        guestIds: [],
        totalHeadcount: 0,
        requiresAccessible: false,
        pinnedTableId: null,
        pinReason: null,
        side: "BOTH",
      };
      unitsByRoot.set(root, unit);
    }
    unit.guestIds.push(g.id);
    unit.totalHeadcount += g.headcount;
    if (g.requiresAccessibleTable) unit.requiresAccessible = true;
    // FR-3.4: BRIDE/GROOM only sticks if every non-BOTH member agrees; a mix (or all-BOTH) stays
    // neutral. First non-BOTH member sets it, a later *conflicting* one resets to neutral.
    if (g.side !== "BOTH") {
      if (unit.side === "BOTH") unit.side = g.side;
      else if (unit.side !== g.side) unit.side = "BOTH";
    }
    // FR-3.7a: a required-table pin takes priority over a lock (it's a hard rule, a lock is a
    // soft "keep them where they were"); either way the whole unit is pinned, since forced-
    // together members are always seated as one.
    if (g.requiredTableId && unit.pinReason !== "required") {
      unit.pinnedTableId = g.requiredTableId;
      unit.pinReason = "required";
    } else if (g.isLocked && g.currentTableId && !unit.pinnedTableId) {
      unit.pinnedTableId = g.currentTableId;
      unit.pinReason = "lock";
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

  // FR-3.4: how many BRIDE/GROOM guests (never BOTH) currently sit at a table -- used both for
  // side-mixing scoring and to know a Single-Side-Only table's "established" side.
  function sideCounts(tableId: string): { bride: number; groom: number } {
    let bride = 0;
    let groom = 0;
    for (const guestId of occupants.get(tableId)!) {
      const side = guestById.get(guestId)?.side;
      if (side === "BRIDE") bride++;
      else if (side === "GROOM") groom++;
    }
    return { bride, groom };
  }

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
    // better, weighted toward the wedding's Side-Mixing setting (FR-3.4, always secondary to the
    // guest-to-guest preferences above), tie-broken toward the tightest fit (least leftover
    // capacity) to reduce fragmentation.
    const w = RULE_WEIGHT_CONFIG;
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
      let score =
        preferHits * w.preferNearBonus - avoidHits * w.avoidPenalty - leftover * w.leftoverCapacityWeight;

      // FR-3.4: guests marked Both never count toward either side, so a BOTH unit is neutral
      // here regardless of setting or of who's already seated at a candidate table.
      if (unit.side !== "BOTH") {
        const counts = sideCounts(t.id);
        const sameSide = unit.side === "BRIDE" ? counts.bride : counts.groom;
        const oppositeSide = unit.side === "BRIDE" ? counts.groom : counts.bride;
        if (sideMixing === "KEEP_SEPARATE") {
          score -= oppositeSide * w.sideMixing.keepSeparateOppositeSidePenalty;
        } else if (sideMixing === "FULLY_MIXED") {
          // Actively push toward an even mix: reward the other side being there, and mildly
          // penalize a table that's already stacked with this unit's own side.
          score += oppositeSide * w.sideMixing.fullyMixedOppositeSideBonus;
          score -= sameSide * (w.sideMixing.fullyMixedOppositeSideBonus * 0.5);
        } else {
          score += oppositeSide * w.sideMixing.balancedMixOppositeSideBonus;
        }
        // A Single-Side-Only table is a table-level override of the wedding's setting: once it
        // has an established side (someone BRIDE- or GROOM-only already seated there), seating
        // the *other* side there is an unmet preference, not a hard block (FR-3.4).
        if (t.singleSideOnly) {
          const established = counts.bride > 0 && counts.groom === 0 ? "BRIDE" : counts.groom > 0 && counts.bride === 0 ? "GROOM" : null;
          if (established && established !== unit.side) {
            score -= w.sideMixing.singleSideOnlyMismatchPenalty;
          }
        }
      }

      // FR-3.7: a Purpose table's structured criterion (Side/Tier/Age Category) favors this table
      // for a matching unit member, and mildly disfavors it (never blocks -- feasibility above
      // never filters on this) for a non-matching one, per guest in the unit.
      if (t.purposeCriterion) {
        const { type, value } = t.purposeCriterion;
        let matches = 0;
        let mismatches = 0;
        for (const guestId of unit.guestIds) {
          const guest = guestById.get(guestId);
          if (!guest) continue;
          const fieldValue = type === "SIDE" ? guest.side : type === "TIER" ? guest.tier : guest.ageCategory;
          if (fieldValue === value) matches++;
          else mismatches++;
        }
        score += matches * w.purposeCriterionBonus - mismatches * w.purposeCriterionMismatchPenalty;
      }

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

    // FR-3.4: surface an unmet Single-Side-Only preference (soft — non-blocking) the same way an
    // AVOID conflict is surfaced below.
    if (unit.side !== "BOTH" && best.singleSideOnly) {
      const countsBefore = { bride: 0, groom: 0 };
      for (const guestId of existingBefore) {
        const side = guestById.get(guestId)?.side;
        if (side === "BRIDE") countsBefore.bride++;
        else if (side === "GROOM") countsBefore.groom++;
      }
      const established =
        countsBefore.bride > 0 && countsBefore.groom === 0
          ? "BRIDE"
          : countsBefore.groom > 0 && countsBefore.bride === 0
            ? "GROOM"
            : null;
      if (established && established !== unit.side) {
        warnings.push(
          `${unit.guestIds.map(guestName).join(", ")} ${unit.guestIds.length === 1 ? "was" : "were"} ` +
            `seated at "${best.label}" (Single-Side-Only) despite being on the other side — no other ` +
            `table had room (weighting-configuration version ${RULE_WEIGHT_CONFIG_VERSION}).`
        );
      }
    }

    // Surface any AVOID conflicts this placement couldn't avoid (soft rule — non-blocking).
    for (const guestId of unit.guestIds) {
      for (const other of existingBefore) {
        if (avoidMap.get(guestId)?.has(other)) {
          warnings.push(
            `${guestName(guestId)} and ${guestName(other)} were seated at the same table despite an ` +
              `"avoid" preference between them — no other table had room (weighting-configuration ` +
              `version ${RULE_WEIGHT_CONFIG_VERSION}).`
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
    // A required-table pin targets its own restricted table directly (attemptPlace doesn't
    // filter by isRestricted -- only the *general* candidateTables pool excludes it), same as a
    // locked pin targeting any table.
    const placedAt = target ? attemptPlace(unit, [target]) : null;
    if (placedAt) continue;

    // The pin couldn't be honored (table deleted/shrunk, or it would now break a hard rule) —
    // fall back to normal automatic placement rather than leaving the guest(s) stranded just
    // because their specific pin is no longer possible. FR-3.7a's own validation (at save time)
    // means this should be rare for a required-table pin -- it only fires if the table's
    // capacity was reduced, or another hard rule now conflicts, after the list was saved.
    const isRequired = unit.pinReason === "required";
    warnings.push(
      `${unit.guestIds.length === 1 ? "Guest" : "Guests"} ${unit.guestIds
        .map(guestName)
        .join(", ")} ${unit.guestIds.length === 1 ? "is" : "are"} ` +
        `${isRequired ? "required at" : "locked to"} ` +
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
    scoreReport: computeScoreReport(guests, relationships, tables, sideMixing, assignments),
  };
}
