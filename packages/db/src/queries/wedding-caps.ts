import type { Queryable } from "./seat-checks";

// TS-205: how big one wedding can get. Before, only creating and copying weddings were limited --
// everything inside a wedding was unlimited, so one account could fill the database (thousands of
// tables, or a new plan version of thousands of seats every few seconds). Each is far above a real
// wedding (the biggest ones have a few hundred guests and a few dozen tables) and is checked under
// the wedding's lock, so two adds at once can't both squeeze under it.
export const WEDDING_CAPS = {
  guests: 2_000,
  tables: 300,
  relationships: 3_000,
  // The ticket's "also uncapped" items: a real day has a few dozen of each.
  timelineEntries: 500,
  vendors: 200,
  /** Plan versions kept; the oldest ones that aren't approved or current are removed past this. */
  planVersionsKept: 50,
} as const;

export type CappedKind = "guests" | "tables" | "relationships" | "timelineEntries" | "vendors";

const NOUN: Record<CappedKind, { one: string; many: string }> = {
  guests: { one: "guest", many: "guests" },
  tables: { one: "table", many: "tables" },
  relationships: { one: "seating rule", many: "seating rules" },
  timelineEntries: { one: "timeline entry", many: "timeline entries" },
  vendors: { one: "vendor", many: "vendors" },
};

const COUNT_SQL: Record<CappedKind, string> = {
  guests: `SELECT count(*)::int AS n FROM "guests" WHERE "weddingId" = $1`,
  tables: `SELECT count(*)::int AS n FROM "seating_tables" WHERE "weddingId" = $1`,
  relationships: `SELECT count(*)::int AS n FROM "guest_relationships" WHERE "weddingId" = $1`,
  timelineEntries: `SELECT count(*)::int AS n FROM "timeline_entries" WHERE "weddingId" = $1`,
  vendors: `SELECT count(*)::int AS n FROM "vendors" WHERE "weddingId" = $1`,
};

/** TS-205: a change would take the wedding past one of WEDDING_CAPS. Nothing was saved. */
export class WeddingCapError extends Error {
  constructor(
    message: string,
    readonly kind: CappedKind
  ) {
    super(message);
  }
}

function plain(n: number): string {
  return n.toLocaleString("en-US");
}

/** TS-205: the plain message for a change that would take the wedding past its cap. */
export function weddingCapMessage(kind: CappedKind, have: number, adding: number): string {
  const cap = WEDDING_CAPS[kind];
  const { one, many } = NOUN[kind];
  const head = `A wedding can have up to ${plain(cap)} ${many}`;
  if (have >= cap) return `${head}, and this one has reached that — remove some ${many} before adding more.`;
  const room = cap - have;
  return `${head}. This one has ${plain(have)}, so there's room for ${plain(room)} more ${room === 1 ? one : many}, not ${plain(adding)}.`;
}

/**
 * TS-205: refuses (WeddingCapError) when adding `adding` more would take the wedding past its cap.
 * Call it with the wedding's lock held (lockWeddingRow), so two adds at once are counted in turn.
 */
export async function assertWeddingHasRoom(q: Queryable, weddingId: string, kind: CappedKind, adding: number): Promise<void> {
  if (adding <= 0) return;
  const { rows } = await q.query(COUNT_SQL[kind], [weddingId]);
  const have = Number(rows[0]?.n ?? 0);
  if (have + adding > WEDDING_CAPS[kind]) throw new WeddingCapError(weddingCapMessage(kind, have, adding), kind);
}

/** TS-205: what pruning needs to know about each of a wedding's plan versions. */
export interface PrunablePlanVersion {
  id: string;
  versionNumber: number;
  status: string;
  isCurrent: boolean;
  restoredFromId: string | null;
}

/**
 * TS-205: which versions to remove so at most `keep` remain -- the oldest ones that are neither
 * approved nor current. A version that a kept version was restored from is skipped too: removing it
 * cleared the kept version's "Restored from version N" (the link is set to null). Skipped in one
 * step only -- a version kept just because it is a source doesn't in turn keep its own source --
 * so a long chain of restores can't grow a wedding's versions without limit (at most `keep` plus
 * the sources of those kept, i.e. no more than twice the cap).
 */
export function planVersionsToPrune(versions: PrunablePlanVersion[], keep: number): string[] {
  const excess = versions.length - keep;
  if (excess <= 0) return [];
  const oldestFirst = [...versions].sort((a, b) => a.versionNumber - b.versionNumber);
  const removable = oldestFirst.filter((v) => v.status !== "APPROVED" && !v.isCurrent).slice(0, excess);
  const removing = new Set(removable.map((v) => v.id));
  const sourcesOfKept = new Set(
    versions.filter((v) => !removing.has(v.id) && v.restoredFromId).map((v) => v.restoredFromId as string)
  );
  return removable.filter((v) => !sourcesOfKept.has(v.id)).map((v) => v.id);
}

/**
 * TS-205: keeps at most WEDDING_CAPS.planVersionsKept plan versions, removing the oldest ones that
 * are neither approved nor current (with their seats and history) -- see planVersionsToPrune. An
 * approved or current version is never removed, even past the cap. Call it with the wedding's lock
 * held, after saving a new version (Generate, Restore). Returns how many were removed.
 */
export async function pruneOldPlanVersions(q: Queryable, weddingId: string): Promise<number> {
  const { rows } = await q.query(
    `SELECT id, "versionNumber", status, "isCurrent", "restoredFromId" FROM "plan_versions" WHERE "weddingId" = $1`,
    [weddingId]
  );
  const ids = planVersionsToPrune(rows as unknown as PrunablePlanVersion[], WEDDING_CAPS.planVersionsKept);
  if (ids.length === 0) return 0;
  const { rowCount } = await q.query(
    `DELETE FROM "plan_versions" WHERE "weddingId" = $1 AND id = ANY($2::text[]) AND status <> 'APPROVED' AND NOT "isCurrent"`,
    [weddingId, ids]
  );
  return rowCount ?? 0;
}
