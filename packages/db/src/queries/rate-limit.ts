import { pool } from "../pool";

// TS-98: fixed-window rate limiting backed by Postgres, so a limit holds across every server
// instance (serverless hosts run many that share no memory) and survives restarts.

export interface RateLimitResult {
  allowed: boolean;
  // Seconds until the current window ends -- what a Retry-After header should say.
  retryAfterSeconds: number;
}

// Counts one hit against `key` in the current window of `windowSeconds`, and says whether it's
// still within `limit`. One atomic upsert, so concurrent requests can't both slip under the limit.
export async function hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const nowMs = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(nowMs / windowMs) * windowMs);

  const { rows } = await pool.query<{ count: number }>(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2, 1)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = "rate_limit_counters".count + 1
     RETURNING count`,
    [key, windowStart]
  );

  // Opportunistic cleanup, ~1 request in 100: windows older than a day are never read again.
  if (Math.random() < 0.01) {
    pool.query(`DELETE FROM "rate_limit_counters" WHERE "windowStart" < now() - interval '1 day'`).catch(() => {});
  }

  return {
    allowed: rows[0].count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + windowMs - nowMs) / 1000)),
  };
}
