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

/**
 * TS-205: keeps at most WEDDING_CAPS.planVersionsKept plan versions, removing the oldest ones that
 * are neither approved nor current (with their seats and history). An approved or current version
 * is never removed, even past the cap. Call it with the wedding's lock held, after saving a new
 * version (Generate, Restore). Returns how many were removed.
 */
export async function pruneOldPlanVersions(q: Queryable, weddingId: string): Promise<number> {
  const { rowCount } = await q.query(
    `DELETE FROM "plan_versions" WHERE id IN (
       SELECT id FROM "plan_versions"
       WHERE "weddingId" = $1 AND status <> 'APPROVED' AND NOT "isCurrent"
       ORDER BY "versionNumber" ASC
       LIMIT GREATEST(0, (SELECT count(*) FROM "plan_versions" WHERE "weddingId" = $1) - $2)
     )`,
    [weddingId, WEDDING_CAPS.planVersionsKept]
  );
  return rowCount ?? 0;
}
