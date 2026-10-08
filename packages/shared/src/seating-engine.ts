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
//     so automatic generation doesn't fill them with new guests -- and (TS-177) everyone already
//     seated at a locked table stays there, as if each were locked (TS-188: and a must-sit partner
//     who isn't already there is left unseated with a warning, never added). If a lock can no longer be
//     honored (the table's gone, or honoring it would break a hard rule), the affected guests
//     fall back to normal automatic placement with a warning explaining why, rather than being
//     left unassigned just because a stale lock couldn't be kept.
//   - A Purpose table's structured criterion (FR-3.7 — Side, Relationship Tier, or Age Category)
//     is a soft preference like prefer-near/avoid: it nudges a matching guest toward that table
//     but never blocks a non-matching guest from being seated there, and overflow beyond the
//     table's capacity is simply placed elsewhere rather than failing generation.
//   - TS-196: if a plan leaves anyone unseated, it's repaired (one seated group moved to make room
//     -- TS-201: or two, in a chain) and also tried in plain largest-first order, and the best is
//     kept: TS-201: fewest people needing an accessible table left unseated, then fewest people.
//     TS-226: if people needing an accessible table are still unseated, one more order is tried --
//     the groups with the most such people first (TS-236: smaller party first on a tie).
//     Every hard rule above still holds in each of them, and the result is the same every time.

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
  // TS-236: when they were seated at currentTableId, as a rank (lower = seated earlier). Decides
  // which locked guests keep a table that no longer has room for all of them -- the same order the
  // table re-check uses -- instead of the guest-list (last-name) order. Optional: without it, guest
  // id decides.
  currentSeatOrder?: number | null;
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
  // TS-181: "lock" is a guest's own lock, "table" is sitting at a locked table (TS-177).
  pinReason: "lock" | "table" | "required" | null;
  // TS-181: someone in this unit is locked themselves -- they go first among table-lock pins.
  hasLockedGuest: boolean;
  // TS-173: why this unit can't be seated at all, when its members' Restricted-table lists
  // disagree (one is required at a table another isn't listed for, or two are required at
  // different tables) -- every table would break a hard rule for someone in it.
  blockedReason: string | null;
  // FR-3.4: BRIDE/GROOM if every non-BOTH member of the unit agrees; BOTH if the unit is all BOTH
  // guests, or mixes BRIDE and GROOM members (a forced-together group already overrides any
  // side-mixing preference for its own members, so it's neutral for scoring purposes).
  side: EngineGuestSide;
}

// FR-0.2 / FR-3.4 / FR-3.7: the soft-rule weighting constants below, versioned. Bump the version
// whenever these numbers (or the formula that uses them) change, so a Plan Version's stored
// ruleConfigVersion always identifies exactly what produced it (FR-3.4's acceptance criterion).
// TS-188: version 3 adds accessibleTableMisusePenalty.
// TS-196: version 4 takes it out again (it could leave a party unseated when there was room for
// everyone -- seating guests who need an accessible table first already keeps those seats for
// them), and adds a repair step for plans that leave someone unseated (see generateSeatingPlan).
// TS-201: version 5 -- plans are compared by people who need an accessible table left unseated
// first, so that ordering really does keep those seats for them (version 4 could swap in a plan that
// gave them away); the repair can move two groups; and which table a must-sit group with locks is
// kept at no longer depends on guest-list order (a locked table wins).
// TS-226: version 6 -- one more order is tried when people who need an accessible table are left
// unseated (groups with the most such people first), so plans can come out differently.
// TS-236: version 7 -- in that order, groups with the same number of such people go smallest party
// first; the repair seats a group at the table with the fewest "avoid" conflicts; and locked guests
// competing for too few seats are decided by seating order (or guest id), not by name.
// TS-244: version 8 -- groups not pinned to a table that tie on party size (and so on "most need
// first" too) go in order of their lowest guest id, not the guest list's last-name order, so
// renaming a guest never changes the plan.
export const RULE_WEIGHT_CONFIG_VERSION = 8;

// TS-244: stands in for the end of a repaired plan's warning until the attempt is finished (see
// runPlacement). Contains characters a guest or table name can never hold.
const REPAIR_PURPOSE = "\u0000repair-purpose\u0000";
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

// TS-201: compares two keys item by item (numbers, or ids compared as plain strings so the result
// never depends on the computer's language settings).
function compareKeys(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export function generateSeatingPlan(
  guests: EngineGuest[],
  relationships: EngineRelationship[],
  tables: EngineTable[],
  sideMixing: EngineSideMixing = "BALANCED_MIX",
  // TS-196: { repair: false } skips the retry/repair step below -- only the unit tests use it, to
  // check the repair never seats fewer guests than the plain engine.
  options: { repair?: boolean } = {}
): SeatingPlanResult {
  const errors: string[] = [];
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
    return { assignments: [], unassignedGuestIds: guests.map((g) => g.id), warnings: [], errors, isComplete: false };
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
        hasLockedGuest: false,
        blockedReason: null,
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
    if (g.isLocked) unit.hasLockedGuest = true;
    if (g.requiredTableId && unit.pinReason !== "required") {
      unit.pinnedTableId = g.requiredTableId;
      unit.pinReason = "required";
    }
  }
  const units = [...unitsByRoot.values()];
  // TS-236: which group each guest is in.
  const unitOfGuest = new Map<string, Unit>();
  for (const u of units) for (const id of u.guestIds) unitOfGuest.set(id, u);

  // TS-201: a unit's lock pin is chosen once every member is known, so it never depends on the
  // order of the guest list (guests come sorted by last name). Before, the first member listed won.
  // Who counts: TS-177 (Tom's decision) -- a locked *table* keeps the people already at it, just
  // like a locked guest (nobody new is seated there: locked tables are left out of the general pool
  // below, and -- TS-188 -- a must-sit partner who isn't already there isn't brought along; see the
  // pinned-unit loop). TS-150: a lock never keeps someone at a Restricted table -- if they belong
  // there, their required-table pin already does; if they've been taken off its list, they move.
  // Which one wins (Tom's decision, "locked table wins"): a member at a locked table, then a guest's
  // own lock (TS-181), then a table that still exists, then the lowest table id, then guest id.
  for (const unit of units) {
    if (unit.pinReason === "required") continue;
    let bestKey: (string | number)[] | null = null;
    for (const id of unit.guestIds) {
      const g = guestById.get(id)!;
      if (!g.currentTableId) continue;
      const t = tablesById.get(g.currentTableId);
      if (!(g.isLocked || t?.isLocked) || t?.isRestricted) continue;
      const key = [t?.isLocked ? 0 : 1, g.isLocked ? 0 : 1, t ? 0 : 1, g.currentTableId, g.id];
      if (!bestKey || compareKeys(key, bestKey) < 0) {
        bestKey = key;
        unit.pinnedTableId = g.currentTableId;
        unit.pinReason = g.isLocked ? "lock" : "table";
      }
    }
  }

  // TS-173: a must-sit-together group goes to a Restricted table only if every member is on that
  // table's list. Before, one listed member pinned the whole group there, seating the unlisted
  // members at a table they aren't allowed at (and the planner couldn't move them out, since moves
  // are blocked both ways). Such a group is left unassigned, with the reason.
  for (const unit of units) {
    const required = new Set(unit.guestIds.map((id) => guestById.get(id)?.requiredTableId ?? null));
    if (unit.pinReason !== "required" || required.size === 1) continue;
    const listed = [...required]
      .filter((t): t is string => t !== null)
      .map((t) => `"${tablesById.get(t)?.label ?? "a Restricted table"}"`);
    unit.blockedReason = required.has(null)
      ? `they must sit together, but not all of them are on ${listed.join(" and ")}'s required list`
      : `they must sit together, but they're required at different tables (${listed.join(" and ")})`;
  }

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
  // TS-196: the placement state below is reset for each attempt (see runPlacement), since a plan
  // that leaves someone unseated is tried again in another order and repaired.
  let remainingCapacity = new Map<string, number>();
  let occupants = new Map<string, string[]>();
  let assignments: SeatingPlanAssignment[] = [];
  let unassignedGuestIds: string[] = [];
  let warnings: string[] = [];

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
  // TS-226: could `unit` sit at `t` right now without breaking a hard rule?
  const canTake = (unit: Unit, t: EngineTable) =>
    (remainingCapacity.get(t.id) ?? 0) >= unit.totalHeadcount &&
    (!unit.requiresAccessible || t.isAccessible) &&
    !hasMustNotConflict(unit, t.id);

  // TS-226: `pinned` is true when `pool` is the one table a pin (a lock, a locked table, or a
  // Restricted table's list) keeps them at, so an unmet preference warning can say so.
  function attemptPlace(unit: Unit, pool: EngineTable[], pinned = false): EngineTable | null {
    const feasible = pool.filter((t) => canTake(unit, t));
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

    // TS-226: why an unmet preference below happened. "No other table had room" only when that's
    // true -- before, it was said even when another table was free and the prefer-near or
    // side-mixing bonus simply outweighed the penalty. Checked against every unlocked,
    // unrestricted table (not just `pool`, which is a single table when re-running a repaired plan).
    // TS-236: `other` is the guest an "avoid" warning is about (none for Single-Side-Only).
    const unmetReason = (other?: string) => {
      if (pinned) {
        const who = unit.guestIds.map(guestName).join(", ");
        const verb = unit.guestIds.length === 1 ? "is" : "are";
        return unit.pinReason === "required"
          ? `${who} ${verb} required at "${best.label}"`
          : `${who} ${verb} kept at "${best.label}" because of a lock`;
      }
      // TS-236: in a repaired plan the table came from the repair, which moved groups to seat
      // everyone -- so "best fit overall" or "no other table had room" wouldn't be true. Say a move
      // did it when this group (or, for "avoid", the other guest's group) was one that moved.
      // TS-244: a repaired plan is kept when it seats more people, not only when it seats everyone,
      // so the end of the sentence (REPAIR_PURPOSE) is chosen once the attempt is finished. A group
      // the repair newly seated "only got a seat" (it wasn't moved -- it had no seat before); and
      // when neither group moved, it says they kept the table they already had.
      if (forcedTable?.has(unit)) {
        const otherUnit = other !== undefined ? unitOfGuest.get(other) : undefined;
        const how = (u: Unit, who: "one of them was" | "they were") =>
          newlySeatedUnits.has(u)
            ? `${who === "they were" ? "they" : "one of them"} only got a seat when seats were rearranged ${REPAIR_PURPOSE}`
            : `${who} moved there ${REPAIR_PURPOSE}`;
        if (movedUnits.has(unit)) return how(unit, other !== undefined ? "one of them was" : "they were");
        if (otherUnit && movedUnits.has(otherUnit)) return how(otherUnit, "one of them was");
        return other !== undefined
          ? `neither of them was moved when seats were rearranged ${REPAIR_PURPOSE}`
          : `they kept their table when seats were rearranged ${REPAIR_PURPOSE}`;
      }
      return candidateTables.some((t) => t.id !== best.id && canTake(unit, t))
        ? "it was the best fit overall, weighing everyone's seating preferences"
        : "no other table had room";
    };

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
            `seated at "${best.label}" (Single-Side-Only) despite being on the other side — ` +
            `${unmetReason()} (weighting-configuration version ${RULE_WEIGHT_CONFIG_VERSION}).`
        );
      }
    }

    // Surface any AVOID conflicts this placement couldn't avoid (soft rule — non-blocking).
    for (const guestId of unit.guestIds) {
      for (const other of existingBefore) {
        if (avoidMap.get(guestId)?.has(other)) {
          warnings.push(
            `${guestName(guestId)} and ${guestName(other)} were seated at the same table despite an ` +
              `"avoid" preference between them — ${unmetReason(other)} (weighting-configuration ` +
              `version ${RULE_WEIGHT_CONFIG_VERSION}).`
          );
        }
      }
    }
    return best;
  }

  function unassignedReason(unit: Unit): string {
    // TS-188: name the real reason when it's one of these, rather than "no remaining capacity".
    if (tables.length === 0) return "there are no tables yet";
    if (candidateTables.length === 0) return "every table is locked or restricted";
    const suitable = candidateTables.filter((t) => !unit.requiresAccessible || t.isAccessible);
    if (unit.requiresAccessible && suitable.length === 0) {
      return tables.some((t) => t.isAccessible)
        ? "every accessible table is locked or restricted"
        : "there's no accessible table";
    }
    if (suitable.every((t) => t.capacity < unit.totalHeadcount)) {
      // TS-196: if a locked or Restricted table is big enough, say the party is only bigger than
      // the tables it could be seated at, not bigger than every table.
      const lockedOrRestrictedFits = tables.some(
        (t) => (!unit.requiresAccessible || t.isAccessible) && t.capacity >= unit.totalHeadcount
      );
      return (
        `their party of ${unit.totalHeadcount} is bigger than any ` +
        `${lockedOrRestrictedFits ? "unlocked, unrestricted " : ""}${unit.requiresAccessible ? "accessible " : ""}table`
      );
    }
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

  // Pinned units are placed first, so their reserved capacity isn't grabbed by other units;
  // unpinned units then follow the existing largest-first heuristic.
  // TS-181: pins go in passes -- required-table pins (a hard rule), then guests' own locks, then
  // people kept at a locked table (TS-177), with individually locked guests first within that
  // pass. Before, pins went in guest-list order and a lock that couldn't be kept was re-seated
  // straight away, so it could take a seat another pin (even a required one) still needed. Now
  // every pin is tried before any lock that couldn't be kept is seated somewhere else.
  // TS-236: within a pass, groups go in the order their members were seated at the pinned table
  // (earliest first, as the table re-check counts them), then by guest id. Before, ties kept the
  // guest-list order -- by last name -- so renaming a guest could change who kept a locked table.
  const pinOrderKey = (u: Unit): (string | number)[] => {
    const here = u.guestIds.filter((id) => guestById.get(id)?.currentTableId === u.pinnedTableId);
    const ids = here.length > 0 ? here : u.guestIds;
    const seatOrder = Math.min(...ids.map((id) => guestById.get(id)?.currentSeatOrder ?? Infinity));
    return [u.hasLockedGuest ? 0 : 1, seatOrder, [...ids].sort()[0]];
  };
  const pinPass = (reason: Unit["pinReason"]) =>
    units
      .filter((u) => u.pinnedTableId && u.pinReason === reason)
      .map((u) => ({ u, key: pinOrderKey(u) }))
      .sort((x, y) => compareKeys(x.key, y.key))
      .map(({ u }) => u);
  const pinnedUnits = [...pinPass("required"), ...pinPass("lock"), ...pinPass("table")];
  // (TS-188: units needing an accessible table are taken out of this order and seated first.)
  // TS-244: equal party sizes go in order of each group's lowest guest id. Before, ties kept the
  // guest-list order -- by last name -- so renaming one guest could change who got seated.
  const lowestId = (u: Unit) => [...u.guestIds].sort()[0];
  const unpinnedUnits = [...units.filter((u) => !u.pinnedTableId)]
    .map((u) => ({ u, id: lowestId(u) }))
    .sort((a, b) => b.u.totalHeadcount - a.u.totalHeadcount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ u }) => u);
  // TS-226: how many people in a group need an accessible table (party sizes).
  const accessibleNeed = (u: Unit) =>
    u.guestIds.reduce((sum, id) => {
      const g = guestById.get(id);
      return sum + (g?.requiresAccessibleTable ? g.headcount : 0);
    }, 0);
  // TS-236: the "most need first" order -- most people needing an accessible table first, then the
  // smaller party (fewer seats taken from them), then as before.
  const needOrder = (x: Unit, y: Unit) =>
    accessibleNeed(y) - accessibleNeed(x) || x.totalHeadcount - y.totalHeadcount;

  // TS-196: where each automatically seated group (a lock that couldn't be kept, or an unpinned
  // group) landed in the current attempt, and -- when re-running a repaired plan -- the table each
  // of them must go to.
  let autoTable = new Map<Unit, string>();
  let forcedTable: Map<Unit, string> | null = null;
  // TS-236: in a repaired plan, the groups the repair moved (or newly seated) -- see unmetReason.
  let movedUnits = new Set<Unit>();
  // TS-244: the ones among them that weren't seated at all before the repair.
  let newlySeatedUnits = new Set<Unit>();
  const autoPool = (unit: Unit): EngineTable[] => {
    const forced = forcedTable?.get(unit);
    return forced ? [tablesById.get(forced)!] : candidateTables;
  };

  const names = (ids: string[]) => ids.map(guestName).join(", ");
  const guestWord = (ids: string[]) => (ids.length === 1 ? "Guest" : "Guests");

  // TS-188: part of a unit, e.g. just the members already sitting at a locked table.
  const subUnit = (unit: Unit, ids: string[]): Unit => ({
    ...unit,
    guestIds: ids,
    totalHeadcount: ids.reduce((sum, id) => sum + (guestById.get(id)?.headcount ?? 0), 0),
    requiresAccessible: ids.some((id) => guestById.get(id)?.requiresAccessibleTable),
  });

  // TS-188: after a pinned unit is seated, say so for anyone in it whose own lock, or seat at a
  // locked table, was somewhere else -- they were moved to stay with the rest of their group.
  function warnMovedPins(unit: Unit, landed: EngineTable) {
    for (const id of unit.guestIds) {
      const g = guestById.get(id);
      if (!g?.currentTableId || g.currentTableId === landed.id) continue;
      const own = tablesById.get(g.currentTableId);
      if (!g.isLocked && !own?.isLocked) continue;
      // TS-150: a lock never keeps anyone at a Restricted table, so leaving one isn't news.
      if (own?.isRestricted) continue;
      const was = !own
        ? "was locked to a table that's been removed"
        : g.isLocked
          ? `is locked to "${own.label}"`
          : `sat at the locked table "${own.label}"`;
      const why =
        g.requiredTableId === landed.id
          ? `they're required at "${landed.label}"`
          : `they must sit with ${names(unit.guestIds.filter((o) => o !== id))}`;
      warnings.push(`Guest ${g.name} ${was}, but ${why}, so they were seated at "${landed.label}" instead.`);
    }
  }

  // TS-181: locks that couldn't be kept are collected into failedLocks, to be seated automatically
  // once every pin has had its turn.
  function placePinnedUnits(failedLocks: { unit: Unit; target: EngineTable | undefined }[]) {
    for (const unit of pinnedUnits) {
      if (unit.blockedReason) {
        unassignedGuestIds.push(...unit.guestIds);
        warnings.push(`Couldn't seat guests ${unit.guestIds.map(guestName).join(", ")} — ${unit.blockedReason}.`);
        continue;
      }
      const target = unit.pinnedTableId ? tablesById.get(unit.pinnedTableId) : undefined;

      // TS-188 (Tom's decision): a locked table keeps the people already at it and nobody new is
      // seated there. Before, one member at a locked table pinned their whole must-sit-together
      // group to it, so a partner who never sat there was added (and could push out someone who
      // did). Now only the members already there are kept; a partner who'd be new there isn't
      // seated (seating them anywhere else would break "must sit together"), with a warning.
      // A Restricted table's required list is the planner's own choice of who sits there, so a
      // required pin isn't split this way.
      let toPlace = unit;
      let newcomers: string[] = [];
      if (target?.isLocked && unit.pinReason !== "required") {
        newcomers = unit.guestIds.filter((id) => guestById.get(id)?.currentTableId !== target.id);
        if (newcomers.length > 0) {
          toPlace = subUnit(unit, unit.guestIds.filter((id) => !newcomers.includes(id)));
        }
      }

      // A required-table pin targets its own restricted table directly (attemptPlace doesn't
      // filter by isRestricted -- only the *general* candidateTables pool excludes it), same as a
      // locked pin targeting any table.
      const placedAt = target ? attemptPlace(toPlace, [target], true) : null;
      if (placedAt) {
        if (newcomers.length > 0) {
          unassignedGuestIds.push(...newcomers);
          const staying = toPlace.guestIds;
          const lockedTable =
            staying.length === 1
              ? `${guestName(staying[0])}'s table "${placedAt.label}" is locked`
              : `${names(staying)} are at "${placedAt.label}", which is locked`;
          // TS-201: a newcomer who is locked to another table, or sits at another locked table, is
          // told about both tables -- their own, and the locked one their partner keeps.
          const ownPin = (id: string): string | null => {
            const g = guestById.get(id)!;
            const own = g.currentTableId ? tablesById.get(g.currentTableId) : undefined;
            if (!own || own.isRestricted) return null;
            if (own.isLocked) return `they sat at the locked table "${own.label}"`;
            return g.isLocked ? `they're locked to "${own.label}"` : null;
          };
          const plain = newcomers.filter((id) => !ownPin(id));
          if (plain.length > 0) {
            warnings.push(
              `Couldn't seat ${guestWord(plain).toLowerCase()} ${names(plain)} — they must sit with ` +
                `${names(staying)}, but ${lockedTable}. Unlock it or move them together.`
            );
          }
          for (const id of newcomers.filter((n) => ownPin(n))) {
            warnings.push(
              `Couldn't seat guest ${guestName(id)} — ${ownPin(id)}, but they must sit with ${names(staying)}, ` +
                `who ${staying.length === 1 ? "is" : "are"} at the locked table "${placedAt.label}". ` +
                `Unlock "${placedAt.label}" or move them together.`
            );
          }
        }
        warnMovedPins(toPlace, placedAt);
        continue;
      }

      // The pin couldn't be honored (table deleted/shrunk, or it would now break a hard rule).
      // TS-173: a guest required at a Restricted table may not sit anywhere else, so a required pin
      // that can't be honored leaves them unassigned (with the reason) rather than seating them
      // automatically at a table that would break that rule.
      if (unit.pinReason === "required") {
        unassignedGuestIds.push(...unit.guestIds);
        warnings.push(
          `Couldn't seat ${unit.guestIds.length === 1 ? "guest" : "guests"} ${unit.guestIds.map(guestName).join(", ")} — ` +
            (target
              ? `they're required at "${target.label}", and it has no room for them (or seating them there would break another hard rule).`
              : "they're required at a table that no longer exists.")
        );
        continue;
      }
      failedLocks.push({ unit, target });
    }
  }

  // A lock is only "keep them where they were", so fall back to normal automatic placement
  // rather than leaving the guest(s) stranded -- after every pin, before the unpinned guests.
  function placeFailedLock({ unit, target }: { unit: Unit; target: EngineTable | undefined }) {
    // TS-188: name only the people the pin was really about -- the locked guest(s) for a lock,
    // or whoever sat at the locked table -- and mention their must-sit partners separately, so an
    // unlocked guest kept at a locked table isn't described as "locked to" it.
    const pinned = unit.guestIds.filter((id) => {
      const g = guestById.get(id);
      return g?.currentTableId === unit.pinnedTableId && (unit.pinReason !== "lock" || g?.isLocked);
    });
    const partners = unit.guestIds.filter((id) => !pinned.includes(id));
    const withPartners = partners.length > 0 ? ` (with ${names(partners)}, who must sit with them)` : "";
    const one = pinned.length === 1;

    const fallback = attemptPlace(unit, autoPool(unit));
    if (fallback) autoTable.set(unit, fallback.id);
    else unassignedGuestIds.push(...unit.guestIds);

    if (!target) {
      // TS-188: say plainly that the table was removed, and what happened instead.
      warnings.push(
        `${guestWord(pinned)} ${names(pinned)} ${one ? "was" : "were"} locked to a table that's been removed, ` +
          (fallback
            ? `so they were seated automatically${withPartners}.`
            : `and couldn't be seated${withPartners} — ${unassignedReason(unit)}.`)
      );
      return;
    }
    const lead =
      unit.pinReason === "lock"
        ? `${one ? "is" : "are"} locked to "${target.label}"`
        : `${one ? "was" : "were"} at the locked table "${target.label}"`;
    // TS-196: one message either way -- before, a lock that couldn't be kept *or* re-seated said
    // "seated automatically instead" and then, separately, that they couldn't be seated.
    warnings.push(
      `${guestWord(pinned)} ${names(pinned)} ${lead}${withPartners}, but that's no longer possible — ` +
        (fallback ? "seated automatically instead." : `and couldn't be seated: ${unassignedReason(unit)}.`)
    );
  }

  function placeUnpinned(unit: Unit) {
    const placedAt = attemptPlace(unit, autoPool(unit));
    if (placedAt) autoTable.set(unit, placedAt.id);
    else {
      unassignedGuestIds.push(...unit.guestIds);
      warnings.push(
        `Couldn't seat ${unit.guestIds.length === 1 ? "guest" : "guests"} ${unit.guestIds
          .map(guestName)
          .join(", ")} — ${unassignedReason(unit)}.`
      );
    }
  }

  // TS-196: one automatic placement -- a lock that couldn't be kept, or an unpinned group.
  type Step = { lock: { unit: Unit; target: EngineTable | undefined } } | { unit: Unit };
  const stepUnit = (step: Step) => ("lock" in step ? step.lock.unit : step.unit);
  const runStep = (step: Step) => ("lock" in step ? placeFailedLock(step.lock) : placeUnpinned(step.unit));

  interface Attempt {
    assignments: SeatingPlanAssignment[];
    unassignedGuestIds: string[];
    warnings: string[];
    autoTable: Map<Unit, string>;
    steps: Step[];
  }

  // One whole attempt at a plan: every pin first, then the automatic placements in the given order.
  // "accessibleFirst" is the normal order -- TS-188: groups that need an accessible table are
  // seated before the rest (failed locks, then unpinned, in each half), so another party can't take
  // the only accessible seats first. TS-196: "largestFirst" is the plain largest-first order
  // (failed locks, then unpinned), tried when the normal order leaves someone unseated. With
  // `forced` (a repaired plan), each listed group is seated at its given table, and anyone not
  // listed is tried last, once every listed group has its seat.
  // TS-226: "accessibleByNeed" is "accessibleFirst" with the groups that need an accessible table
  // ordered by how many of their people need it (most first; ties keep the normal order), so a big
  // party with one person needing those seats can't take them from a group where everyone does.
  // TS-227: failed locks are in that ordering too -- a locked group whose table is gone used to go
  // ahead of every unpinned group however few of its people needed the accessible seats.
  function runPlacement(
    order: "accessibleFirst" | "largestFirst" | "accessibleByNeed",
    forced: Map<Unit, string> | null,
    // TS-236: with `forced`, where each group sat in the attempt that was repaired.
    repairedFrom: Map<Unit, string> | null = null
  ): Attempt {
    remainingCapacity = new Map(tables.map((t) => [t.id, t.capacity]));
    occupants = new Map(tables.map((t) => [t.id, []]));
    assignments = [];
    unassignedGuestIds = [];
    warnings = [];
    autoTable = new Map();
    forcedTable = forced;
    movedUnits = new Set([...(forced ?? [])].filter(([u, t]) => repairedFrom?.get(u) !== t).map(([u]) => u));
    newlySeatedUnits = new Set([...movedUnits].filter((u) => !repairedFrom?.has(u)));

    const failedLocks: { unit: Unit; target: EngineTable | undefined }[] = [];
    placePinnedUnits(failedLocks);

    const accessibleSteps: Step[] = [
      ...failedLocks.filter((f) => f.unit.requiresAccessible).map((lock) => ({ lock })),
      ...unpinnedUnits.filter((u) => u.requiresAccessible).map((unit) => ({ unit })),
    ];
    if (order === "accessibleByNeed") {
      // TS-236: equal counts go smallest party first -- before, the bigger party went first, so a
      // couple where one needs the accessible seats could take them from two guests who both do.
      // Array sort is stable, so full ties keep the normal order (failed locks, then largest first).
      accessibleSteps.sort((x, y) => needOrder(stepUnit(x), stepUnit(y)));
    }
    const steps: Step[] =
      order !== "largestFirst"
        ? [
            ...accessibleSteps,
            ...failedLocks.filter((f) => !f.unit.requiresAccessible).map((lock) => ({ lock })),
            ...unpinnedUnits.filter((u) => !u.requiresAccessible).map((unit) => ({ unit })),
          ]
        : [...failedLocks.map((lock) => ({ lock })), ...unpinnedUnits.map((unit) => ({ unit }))];
    const later: Step[] = [];
    for (const step of steps) {
      if (forced && !forced.has(stepUnit(step))) later.push(step);
      else runStep(step);
    }
    forcedTable = null;
    for (const step of later) runStep(step);
    // TS-244: "so everyone could be seated" only when this attempt really seats everyone.
    const purpose = unassignedGuestIds.length === 0 ? "so everyone could be seated" : "to make room for more guests";
    warnings = warnings.map((w) => w.split(REPAIR_PURPOSE).join(purpose));
    return { assignments, unassignedGuestIds, warnings, autoTable, steps };
  }

  // TS-196: a repair of an attempt that left unpinned groups unseated. For each of them (in seating
  // order): if some table would have room once one already-seated unpinned group moved to another
  // table, make that move and seat them there. TS-201: anyone still unseated after that gets a
  // second pass that may move two groups in a chain (the group making room may itself need another
  // group to move -- e.g. two groups swapping tables). Only unpinned groups ever move, always whole,
  // and only between unlocked, unrestricted tables; every move keeps room, accessible-table needs
  // and "must not sit together" rules, and nobody already seated is ever left unseated. Returns
  // where every automatically seated group should sit, or null if nobody more could be seated.
  // TS-201: the budget counts the work really done -- each table and group looked at, and each
  // seated guest compared against a "must not sit together" list -- so a huge wedding or a huge
  // list of rules can't stall generation (counting work, not time, keeps the result the same on
  // every run). Each guest in the two-move pass gets at most a share of it, so one hard case can't
  // use it all up.
  const REPAIR_WORK_BUDGET = 2_000_000;
  const REPAIR_TWO_MOVE_SHARE = 100_000;
  function repair(attempt: Attempt): Map<Unit, string> | null {
    const tableOfUnit = new Map(attempt.autoTable);
    const occ = new Map<string, Set<string>>(tables.map((t) => [t.id, new Set<string>()]));
    const rem = new Map(tables.map((t) => [t.id, t.capacity]));
    for (const a of attempt.assignments) {
      occ.get(a.tableId)!.add(a.guestId);
      rem.set(a.tableId, rem.get(a.tableId)! - (guestById.get(a.guestId)?.headcount ?? 0));
    }
    // Unpinned groups at each unlocked, unrestricted table -- the only ones a repair may move.
    const movableAt = new Map<string, Unit[]>(candidateTables.map((t) => [t.id, []]));
    for (const u of unpinnedUnits) {
      const t = tableOfUnit.get(u);
      if (t) movableAt.get(t)?.push(u);
    }
    let work = 0;
    // TS-201: compares the table's few occupants against each guest's must-not list, rather than
    // walking the whole list (which could be hundreds of names per guest), and counts that work.
    const clashes = (unit: Unit, tableId: string, leaving: Unit | null) => {
      const here = occ.get(tableId)!;
      for (const g of unit.guestIds) {
        const mustNot = mustNotMap.get(g);
        if (!mustNot) continue;
        work += here.size;
        for (const o of here) if (mustNot.has(o) && !leaving?.guestIds.includes(o)) return true;
      }
      return false;
    };
    const fits = (unit: Unit, t: EngineTable, leaving: Unit | null) =>
      (!unit.requiresAccessible || t.isAccessible) &&
      rem.get(t.id)! + (leaving?.totalHeadcount ?? 0) >= unit.totalHeadcount &&
      !clashes(unit, t.id, leaving);
    // TS-226: free seats at unlocked, unrestricted tables. Moving a group between them never
    // changes this, so a group bigger than it can't be seated by any repair -- it's skipped
    // without spending the work budget (before, the repair used its whole budget on such groups
    // when there were far more guests than seats).
    let freeSeats = candidateTables.reduce((sum, t) => sum + Math.max(0, rem.get(t.id)!), 0);
    const seat = (unit: Unit, t: EngineTable) => {
      for (const g of unit.guestIds) occ.get(t.id)!.add(g);
      rem.set(t.id, rem.get(t.id)! - unit.totalHeadcount);
      freeSeats -= unit.totalHeadcount;
      movableAt.get(t.id)!.push(unit);
      tableOfUnit.set(unit, t.id);
    };
    const unseat = (unit: Unit, t: EngineTable) => {
      for (const g of unit.guestIds) occ.get(t.id)!.delete(g);
      rem.set(t.id, rem.get(t.id)! + unit.totalHeadcount);
      freeSeats += unit.totalHeadcount;
      const list = movableAt.get(t.id)!;
      list.splice(list.indexOf(unit), 1);
      tableOfUnit.delete(unit);
    };

    // Seats `unit` at the first table with room, moving at most `moves` seated groups to make it
    // (each to another table, possibly making room there the same way). `fixed` holds the groups
    // already placed in this chain, which it won't move again. If it can't, or it runs past
    // `limit`, everything is put back as it was and it returns false.
    // TS-236: how many "avoid" preferences seating `unit` at a table would break (work counted).
    const hasAvoids = (unit: Unit) => unit.guestIds.some((g) => avoidMap.has(g));
    const avoidConflicts = (unit: Unit, tableId: string) => {
      const here = occ.get(tableId)!;
      let n = 0;
      for (const g of unit.guestIds) {
        const avoid = avoidMap.get(g);
        if (!avoid) continue;
        work += here.size;
        for (const o of here) if (avoid.has(o)) n++;
      }
      return n;
    };

    function insert(unit: Unit, moves: number, fixed: Set<Unit>, limit: number): boolean {
      // TS-236: among tables with room, the one with the fewest "avoid" conflicts (first in table
      // order on a tie). Before, it took the first table with room whatever the preferences. A group
      // with no "avoid" preferences still takes the first table with room, as before.
      const checkAvoids = hasAvoids(unit);
      let pick: EngineTable | null = null;
      let pickConflicts = Infinity;
      for (const t of candidateTables) {
        if (work > limit) break; // out of budget: keep a table already found, if any
        work++;
        if (t.capacity < unit.totalHeadcount || (unit.requiresAccessible && !t.isAccessible)) continue;
        if (fits(unit, t, null)) {
          const conflicts = checkAvoids ? avoidConflicts(unit, t.id) : 0;
          if (conflicts < pickConflicts) {
            pick = t;
            pickConflicts = conflicts;
          }
          if (pickConflicts === 0) break;
        }
      }
      if (pick) {
        seat(unit, pick);
        return true;
      }
      if (moves === 0 || work > limit) return false;
      for (const tv of candidateTables) {
        if (tv.capacity < unit.totalHeadcount || (unit.requiresAccessible && !tv.isAccessible)) continue;
        for (const moving of [...movableAt.get(tv.id)!]) {
          if (work > limit) return false;
          work++;
          if (fixed.has(moving) || !fits(unit, tv, moving)) continue;
          unseat(moving, tv);
          seat(unit, tv);
          fixed.add(unit);
          if (insert(moving, moves - 1, fixed, limit)) return true;
          fixed.delete(unit);
          unseat(unit, tv);
          seat(moving, tv);
        }
      }
      return false;
    }

    let improved = false;
    // One move for everyone first (as TS-196 did), then two moves for whoever is still unseated.
    for (const moves of [1, 2]) {
      for (const step of attempt.steps) {
        if (work > REPAIR_WORK_BUDGET) break;
        if ("lock" in step || tableOfUnit.has(step.unit)) continue;
        if (freeSeats < step.unit.totalHeadcount) continue; // TS-226: can't fit, see freeSeats
        const limit = moves === 1 ? REPAIR_WORK_BUDGET : Math.min(REPAIR_WORK_BUDGET, work + REPAIR_TWO_MOVE_SHARE);
        if (insert(step.unit, moves, new Set(), limit)) improved = true;
      }
    }
    return improved ? tableOfUnit : null;
  }

  // TS-196: if the normal order leaves anyone unseated, also try a repaired plan, the plain
  // largest-first order, and that order repaired, and keep the best of them (a tie keeps the
  // earlier one, so the normal plan wins unless another really is better). Every one of them keeps
  // every hard rule.
  const primary = runPlacement("accessibleFirst", null);
  let best = primary;
  if (primary.unassignedGuestIds.length > 0 && options.repair !== false) {
    // TS-201: compared first by people who need an accessible table left unseated (party sizes),
    // then by all people left unseated, then by parties -- so another plan is never kept just
    // because it seats more people by giving the accessible seats to guests who don't need them,
    // and a plan that leaves one party of 6 unseated is worse than one that leaves two singles.
    const rank = (x: Attempt) => {
      let accessible = 0;
      let people = 0;
      for (const id of x.unassignedGuestIds) {
        const g = guestById.get(id);
        people += g?.headcount ?? 0;
        if (g?.requiresAccessibleTable) accessible += g.headcount;
      }
      return [accessible, people, x.unassignedGuestIds.length];
    };
    const better = (a: Attempt) => {
      if (compareKeys(rank(a), rank(best)) < 0) best = a;
    };
    const repaired = repair(primary);
    if (repaired) better(runPlacement("accessibleFirst", repaired, primary.autoTable));
    if (best.unassignedGuestIds.length > 0) {
      const alternate = runPlacement("largestFirst", null);
      better(alternate);
      if (best.unassignedGuestIds.length > 0 && alternate.unassignedGuestIds.length > 0) {
        const repairedAlternate = repair(alternate);
        if (repairedAlternate) better(runPlacement("largestFirst", repairedAlternate, alternate.autoTable));
      }
    }
    // TS-226: if people who need an accessible table are still left unseated, also try seating the
    // groups with the most such people first. Tried last, so it's only kept when strictly better --
    // a plan can never get worse. Skipped when it would be the same order as the normal one.
    // TS-227: judged on the normal attempt's own accessible steps, failed locks included.
    const accessibleOrder = primary.steps.map(stepUnit).filter((u) => u.requiresAccessible);
    // TS-236: same order as the sort above (smaller party first on equal need).
    const needOrderDiffers = accessibleOrder.some((u, i) => i > 0 && needOrder(u, accessibleOrder[i - 1]) < 0);
    if (rank(best)[0] > 0 && needOrderDiffers) better(runPlacement("accessibleByNeed", null));
  }

  return {
    assignments: best.assignments,
    unassignedGuestIds: best.unassignedGuestIds,
    warnings: best.warnings,
    errors,
    isComplete: best.unassignedGuestIds.length === 0,
    scoreReport: computeScoreReport(guests, relationships, tables, sideMixing, best.assignments),
  };
}
