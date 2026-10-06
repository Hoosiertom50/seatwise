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

function windowStartFor(nowMs: number, windowMs: number): Date {
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

// The previous window's count still inside the last `windowMs` -- rounded up, so a split can
// never come out below the real number of tries.
function carriedOver(previous: number, windowStart: Date, windowMs: number, nowMs: number): number {
  if (previous === 0) return 0;
  const stillInside = 1 - (nowMs - windowStart.getTime()) / windowMs;
  return Math.ceil(previous * stillInside);
}

async function previousWindowCount(key: string, windowStart: Date, windowMs: number): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2`,
    [key, new Date(windowStart.getTime() - windowMs)]
  );
  return rows[0]?.count ?? 0;
}

/**
 * TS-186: how long until one more try fits under a sliding limit, in whole seconds (at least 1).
 * `current` is what the current window already holds (not counting the try being asked about),
 * `previous` what the window before it holds, and `elapsedSeconds` how far into the current window
 * it is. One more try fits once current + (the previous window's count, scaled by how much of it
 * is still inside the last `windowSeconds`, rounded up) is below `limit`. Before, Retry-After
 * always said "when this window ends" -- too soon while the previous window still counted.
 *
 * Never more than the rest of this window plus one whole window -- the longest a sliding count
 * can hold on to anything.
 */
export function slidingRetryAfterSeconds({
  current,
  previous,
  limit,
  windowSeconds,
  elapsedSeconds,
}: {
  current: number;
  previous: number;
  limit: number;
  windowSeconds: number;
  elapsedSeconds: number;
}): number {
  const W = windowSeconds;
  const elapsed = Math.min(Math.max(elapsedSeconds, 0), W);
  const longest = 2 * W - elapsed;
  // How many of the previous window's tries may still count while one more try fits.
  const room = limit - 1 - current;
  let wait: number;
  if (room >= 0) {
    if (previous <= room) return 1;
    // Fits once previous x (1 - f) <= room, f being the share of the current window gone by.
    wait = (1 - room / previous) * W - elapsed;
  } else {
    // This window alone is over the limit: wait for it to end, and then until enough of it has
    // slid out of the next one (where this window's count is the "previous" one).
    const shareNeeded = current > 0 ? Math.max(0, 1 - (limit - 1) / current) : 0;
    wait = W - elapsed + shareNeeded * W;
  }
  return Math.max(1, Math.min(Math.ceil(wait - 1e-9), Math.ceil(longest)));
}

export interface RateLimitResult {
  allowed: boolean;
  // Seconds until another try would be allowed -- what a Retry-After header should say.
  retryAfterSeconds: number;
  /**
   * TS-186: the window this was counted in. Pass it to undoRateLimitHit to take back exactly this
   * hit, even if a new window has started in between.
   */
  windowStart: Date;
}

function retryAfter(current: number, previous: number, limit: number, windowSeconds: number, windowStart: Date, nowMs: number): number {
  const elapsedSeconds = (nowMs - windowStart.getTime()) / 1000;
  if (!slides(windowSeconds)) return Math.max(1, Math.ceil(windowSeconds - elapsedSeconds));
  return slidingRetryAfterSeconds({ current, previous, limit, windowSeconds, elapsedSeconds });
}

// Counts one hit against `key` in the current window of `windowSeconds`, and says whether it's
// still within `limit`. One atomic upsert, so concurrent requests can't both slip under the limit.
// TS-186: a refused hit is still counted here -- callers give it back (undoRateLimitHit with the
// returned windowStart), so refused tries don't stretch a lockout.
export async function hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const nowMs = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = windowStartFor(nowMs, windowMs);

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

  const previous = slides(windowSeconds) ? await previousWindowCount(key, windowStart, windowMs) : 0;
  const counted = rows[0].count + carriedOver(previous, windowStart, windowMs, nowMs);
  return {
    allowed: counted <= limit,
    // TS-186: worked out without this hit -- as things stand once a refused hit is given back.
    retryAfterSeconds: retryAfter(rows[0].count - 1, previous, limit, windowSeconds, windowStart, nowMs),
    windowStart,
  };
}

// TS-163: counts one hit against `key` in the current window and returns the new count -- for a
// limit with more than one threshold (the daily email ceiling, with headroom for password resets).
// TS-186: and the window it was counted in, for undoRateLimitHit.
export async function hitRateLimitCount(key: string, windowSeconds: number): Promise<{ count: number; windowStart: Date }> {
  const windowStart = windowStartFor(Date.now(), windowSeconds * 1000);
  const { rows } = await pool.query<{ count: number }>(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2, 1)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = "rate_limit_counters".count + 1
     RETURNING count`,
    [key, windowStart]
  );
  return { count: rows[0].count, windowStart };
}

// TS-113: how many hits `key` already has in the current window, without adding one -- for limits
// that only count failures (a failed sign-in), so the check happens before the attempt and the
// count only goes up if it fails.
export async function peekRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const nowMs = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = windowStartFor(nowMs, windowMs);
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2`,
    [key, windowStart]
  );
  const current = rows[0]?.count ?? 0;
  const previous = slides(windowSeconds) ? await previousWindowCount(key, windowStart, windowMs) : 0;
  return {
    allowed: current + carriedOver(previous, windowStart, windowMs, nowMs) < limit,
    retryAfterSeconds: retryAfter(current, previous, limit, windowSeconds, windowStart, nowMs),
    windowStart,
  };
}

// TS-155: takes back one hit counted by hitRateLimit -- used where an attempt is counted *before*
// it's checked (so parallel attempts can't all slip past the limit) and then turns out to be one
// that shouldn't count, such as a correct password.
// TS-186: pass the windowStart the hit returned, so exactly that hit is taken back -- before, a
// hit counted just before a window ended was "taken back" from the next window instead. Without
// it, the current window is used (as before).
export async function undoRateLimitHit(key: string, windowSeconds: number, windowStart?: Date): Promise<void> {
  const start = windowStart ?? windowStartFor(Date.now(), windowSeconds * 1000);
  await pool.query(
    `UPDATE "rate_limit_counters" SET count = GREATEST(count - 1, 0) WHERE key = $1 AND "windowStart" = $2`,
    [key, start]
  );
}

// TS-186: "at most once per `seconds`" -- for the hourly RSVP-link and RSVP-notification emails.
// These used a limit of 1 on a sliding window, which (since TS-184) could hold one send back for
// up to two hours, and every refused click counted again and pushed it further out. A cooldown
// keeps the moment it was last claimed instead (one row per claim, whose windowStart is that
// moment): a new claim is allowed once `seconds` have really passed, and a refused claim records
// nothing.
export interface CooldownClaim {
  allowed: boolean;
  retryAfterSeconds: number;
  /** When it was claimed (allowed only) -- pass to releaseCooldown if nothing was sent after all. */
  claimedAt: Date | null;
}

// Keeps these locks apart from the app's other advisory locks (which use the one-number form).
const COOLDOWN_LOCK_SPACE = 186;

export async function claimCooldown(key: string, seconds: number): Promise<CooldownClaim> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One claim at a time per key, so two requests at the same moment can't both be first.
    await client.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [COOLDOWN_LOCK_SPACE, key]);
    const nowMs = Date.now();
    const { rows } = await client.query<{ windowStart: Date }>(
      `SELECT "windowStart" FROM "rate_limit_counters"
        WHERE key = $1 AND count > 0 AND "windowStart" > $2
        ORDER BY "windowStart" DESC LIMIT 1`,
      [key, new Date(nowMs - seconds * 1000)]
    );
    if (rows[0]) {
      await client.query("COMMIT");
      const endsMs = new Date(rows[0].windowStart).getTime() + seconds * 1000;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((endsMs - nowMs) / 1000)), claimedAt: null };
    }
    const claimedAt = new Date(nowMs);
    await client.query(
      `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2, 1)
       ON CONFLICT (key, "windowStart") DO UPDATE SET count = 1`,
      [key, claimedAt]
    );
    await client.query("COMMIT");
    return { allowed: true, retryAfterSeconds: 0, claimedAt };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** TS-186: takes back a claim made by claimCooldown -- for an email that didn't go out after all. */
export async function releaseCooldown(key: string, claimedAt: Date): Promise<void> {
  await pool.query(`DELETE FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2`, [key, claimedAt]);
}
