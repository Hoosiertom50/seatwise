import { pool } from "../pool";

// TS-98: window-based rate limiting backed by Postgres, so a limit holds across every server
// instance (serverless hosts run many that share no memory) and survives restarts.

// TS-184: limits shorter than a day (sign-in failures, hourly email caps) also count the previous
// window, weighted by how much of it still falls inside the last `windowSeconds`. Before, the
// count started again from zero on the quarter hour, so tries made just before and just after it
// got twice the limit (and 100 wrong passwords spread across 2:15 never locked the account).
// Daily limits stay calendar days (UTC), because their messages say "today" and "tomorrow".
function slides(windowSeconds: number): boolean {
  return windowSeconds < 86_400;
}

// The previous window's count still inside the last `windowMs` -- rounded up, so a split can
// never come out below the real number of tries.
async function carriedOver(key: string, windowStart: Date, windowMs: number, nowMs: number): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2`,
    [key, new Date(windowStart.getTime() - windowMs)]
  );
  const previous = rows[0]?.count ?? 0;
  if (previous === 0) return 0;
  const stillInside = 1 - (nowMs - windowStart.getTime()) / windowMs;
  return Math.ceil(previous * stillInside);
}

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

  const counted = rows[0].count + (slides(windowSeconds) ? await carriedOver(key, windowStart, windowMs, nowMs) : 0);
  return {
    allowed: counted <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + windowMs - nowMs) / 1000)),
  };
}

// TS-163: counts one hit against `key` in the current window and returns the new count -- for a
// limit with more than one threshold (the daily email ceiling, with headroom for password resets).
export async function hitRateLimitCount(key: string, windowSeconds: number): Promise<number> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const { rows } = await pool.query<{ count: number }>(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2, 1)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = "rate_limit_counters".count + 1
     RETURNING count`,
    [key, windowStart]
  );
  return rows[0].count;
}

// TS-113: how many hits `key` already has in the current window, without adding one -- for limits
// that only count failures (a failed sign-in), so the check happens before the attempt and the
// count only goes up if it fails.
export async function peekRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const nowMs = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(nowMs / windowMs) * windowMs);
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2`,
    [key, windowStart]
  );
  const counted =
    (rows[0]?.count ?? 0) + (slides(windowSeconds) ? await carriedOver(key, windowStart, windowMs, nowMs) : 0);
  return {
    allowed: counted < limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + windowMs - nowMs) / 1000)),
  };
}

// TS-155: takes back one hit counted by hitRateLimit in the current window -- used where an attempt
// is counted *before* it's checked (so parallel attempts can't all slip past the limit) and then
// turns out to be one that shouldn't count, such as a correct password.
export async function undoRateLimitHit(key: string, windowSeconds: number): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  await pool.query(
    `UPDATE "rate_limit_counters" SET count = GREATEST(count - 1, 0) WHERE key = $1 AND "windowStart" = $2`,
    [key, windowStart]
  );
}
