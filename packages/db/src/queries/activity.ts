import { pool } from "../pool";

// FR-10.1: a single chronological activity log across every plan version of a wedding (the
// existing change_history_entries table is scoped per-version everywhere else it's queried).
// description was always plain text captured at write time (never a live FK), so removed targets
// already stay understandable here for free.
export interface ActivityEntryRow {
  id: string;
  planVersionId: string;
  versionNumber: number;
  action: string;
  description: string;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: Date;
}

export async function listActivityForWedding(weddingId: string, limit = 200): Promise<ActivityEntryRow[]> {
  const { rows } = await pool.query(
    `SELECT che.id, che."planVersionId", pv."versionNumber", che.action, che.description,
            che."actorUserId", u.name AS "actorName", che."createdAt"
     FROM "change_history_entries" che
     JOIN "plan_versions" pv ON pv.id = che."planVersionId"
     LEFT JOIN "users" u ON u.id = che."actorUserId"
     WHERE pv."weddingId" = $1
     ORDER BY che."createdAt" DESC
     LIMIT $2`,
    [weddingId, limit]
  );
  return rows;
}
