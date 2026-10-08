import { beginTransaction, pool } from "../pool";

// TS-98: window-based rate limiting backed by Postgres, so a limit holds across every server
// instance (serverless hosts run many that share no memory) and survives restarts.

// TS-184: limits shorter than a day (sign-in failures, hourly email caps) also count the previous
// window, weighted by how much of it still falls inside the last `windowSeconds`. Before, the
// count started again from zero on the quarter hour, so tries made just before and just after it
// got twice the limit (and 100 wrong passwords spread across 2:15 never locked the account).
// TS-194: the site-wide email counts roll over the last 24 hours (hitRollingCount).
// TS-203: and so does every other limit of a day or more. They used to be calendar days (UTC), so
// a burst just before and just after midnight UTC (8 pm Eastern) got twice the day's limit inside a
// couple of hours -- an account's email allowance, the owner's pool for guests' answers, a network
// address's account emails. A daily limit is now kept in hourly windows and counts everything in
// the current hour plus the 24 hours before it (see rollingTotal), under the same keys as before --
// so calendar-day counts already stored (whose window starts at midnight, an hour boundary) keep
// counting until they age out, instead of every count starting again from zero on deploy.
function slides(windowSeconds: number): boolean {
  return windowSeconds < 86_400;
}

/** TS-203: whether a limit of `windowSeconds` rolls (a day or more) rather than sliding. */
function rolls(windowSeconds: number): boolean {
  return !slides(windowSeconds);
}

/** TS-203: how long each stored window is -- an hour for a rolling limit, otherwise the limit's own window. */
function bucketMsFor(windowSeconds: number): number {
  return rolls(windowSeconds) ? ROLLING_BUCKET_SECONDS * 1000 : windowSeconds * 1000;
}

function windowStartFor(nowMs: number, windowMs: number): Date {
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

// TS-194: "windowStart" has no time zone, and the database driver used to turn a JavaScript date
// into the server's local time on the way in (and read it back the same way). Two servers in
// different time zones -- or a server and the test helpers -- then disagreed about which window a
// count was in. Every time stored here is now written as UTC (a text value, whose "Z" the column
// ignores) and read back with EXTRACT(EPOCH ...), which treats it as UTC too -- so the window
// arithmetic is the same whatever time zone the server runs in. Only this table is affected; the
// rest of the app's timestamps are untouched.
function utc(date: Date): string {
  return date.toISOString();
}

// The previous window's count still inside the last `windowMs` -- rounded up, so a split can
// never come out below the real number of tries.
function carriedOver(previous: number, windowStart: Date, windowMs: number, nowMs: number): number {
  if (previous === 0) return 0;
  const stillInside = 1 - (nowMs - windowStart.getTime()) / windowMs;
  // TS-194: the tiny allowance stops floating-point noise (2.0000000001) rounding up a whole try.
  return Math.ceil(previous * stillInside - 1e-9);
}

async function previousWindowCount(key: string, windowStart: Date, windowMs: number): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2::timestamp`,
    [key, utc(new Date(windowStart.getTime() - windowMs))]
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
  return slidingRetryAfterSeconds({ current, previous, limit, windowSeconds, elapsedSeconds });
}

/**
 * TS-203: how long until one more try fits under a rolling limit, in whole seconds (at least 1).
 * `windows` are the stored hourly windows (the current one included, without the try being asked
 * about). A window stops counting once the current window starts more than `spanSeconds` after
 * it, so the answer is the first moment -- now, or when one of the windows drops out -- at which
 * everything still counted is below `limit`. Pure, so it can be unit-tested.
 */
export function rollingRetryAfterSeconds({
  windows,
  limit,
  nowMs,
  spanSeconds = ROLLING_SPAN_SECONDS,
  bucketSeconds = ROLLING_BUCKET_SECONDS,
}: {
  windows: { startMs: number; count: number }[];
  limit: number;
  nowMs: number;
  spanSeconds?: number;
  bucketSeconds?: number;
}): number {
  const bucketMs = bucketSeconds * 1000;
  const spanMs = spanSeconds * 1000;
  const countedAt = (t: number) => {
    const oldest = Math.floor(t / bucketMs) * bucketMs - spanMs;
    return windows.filter((w) => w.startMs >= oldest).reduce((sum, w) => sum + Number(w.count), 0);
  };
  // Each window drops out when the window after the one `spanSeconds` later begins.
  const moments = [nowMs, ...windows.map((w) => w.startMs + spanMs + bucketMs)].filter((t) => t >= nowMs).sort((a, b) => a - b);
  for (const t of moments) {
    if (countedAt(t) <= limit - 1) return Math.max(1, Math.ceil((t - nowMs) / 1000 - 1e-9));
  }
  return Math.ceil((spanMs + bucketMs) / 1000);
}

/** TS-203: the stored windows of a rolling limit still inside its span (the current one included). */
async function rollingWindows(key: string, currentStart: Date, spanSeconds: number): Promise<{ startMs: number; count: number }[]> {
  const { rows } = await pool.query<{ startMs: number; count: number }>(
    `SELECT (EXTRACT(EPOCH FROM "windowStart") * 1000)::float8 AS "startMs", count FROM "rate_limit_counters"
      WHERE key = $1 AND "windowStart" >= $2::timestamp AND "windowStart" <= $3::timestamp`,
    [key, utc(new Date(currentStart.getTime() - spanSeconds * 1000)), utc(currentStart)]
  );
  return rows.map((r) => ({ startMs: Number(r.startMs), count: Number(r.count) }));
}

/**
 * TS-237: runs the read that follows a hit's INSERT. If it fails (the database busy), the hit --
 * already saved -- is taken back before the error goes on: the caller only sees an error, so it
 * can't give back a hit it was never told about, and that hit used to stay counted.
 */
async function refundIfFails<T>(key: string, windowStart: Date, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    await undoRateLimitHit(key, ROLLING_BUCKET_SECONDS, windowStart).catch(() => {});
    throw err;
  }
}

/**
 * TS-203: counts one hit in the current hourly window of a rolling limit. Returns the rolling total
 * (this hit included), and every window as it stands without this hit (for rollingRetryAfterSeconds).
 */
async function hitRolling(key: string, spanSeconds: number, nowMs: number) {
  const windowStart = windowStartFor(nowMs, ROLLING_BUCKET_SECONDS * 1000);
  const { rows } = await pool.query<{ count: number }>(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2::timestamp, 1)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = "rate_limit_counters".count + 1
     RETURNING count`,
    [key, utc(windowStart)]
  );
  pruneOldCounters();
  const current = Number(rows[0].count);
  // TS-237: if reading the earlier windows fails, this hit is taken back before the error goes on.
  const earlier = (await refundIfFails(key, windowStart, () => rollingWindows(key, windowStart, spanSeconds))).filter(
    (w) => w.startMs !== windowStart.getTime()
  );
  const total = rollingTotal(current, earlier, windowStart.getTime(), spanSeconds);
  const without = [...earlier, { startMs: windowStart.getTime(), count: current - 1 }];
  return { windowStart, total, without };
}

// Counts one hit against `key` in the current window of `windowSeconds`, and says whether it's
// still within `limit`. One atomic upsert, so concurrent requests can't both slip under the limit.
// TS-186: a refused hit is still counted here -- callers give it back (undoRateLimitHit with the
// returned windowStart), so refused tries don't stretch a lockout.
export async function hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const nowMs = Date.now();
  // TS-203: a day or more rolls (see rolls()).
  if (rolls(windowSeconds)) {
    const { windowStart, total, without } = await hitRolling(key, windowSeconds, nowMs);
    return {
      allowed: total <= limit,
      retryAfterSeconds: rollingRetryAfterSeconds({ windows: without, limit, nowMs, spanSeconds: windowSeconds }),
      windowStart,
    };
  }
  const windowMs = windowSeconds * 1000;
  const windowStart = windowStartFor(nowMs, windowMs);

  const { rows } = await pool.query<{ count: number }>(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2::timestamp, 1)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = "rate_limit_counters".count + 1
     RETURNING count`,
    [key, utc(windowStart)]
  );

  pruneOldCounters();

  // TS-237: likewise, a failed read of the previous window takes this hit back.
  const previous = await refundIfFails(key, windowStart, () => previousWindowCount(key, windowStart, windowMs));
  const counted = rows[0].count + carriedOver(previous, windowStart, windowMs, nowMs);
  return {
    allowed: counted <= limit,
    // TS-186: worked out without this hit -- as things stand once a refused hit is given back.
    retryAfterSeconds: retryAfter(rows[0].count - 1, previous, limit, windowSeconds, windowStart, nowMs),
    windowStart,
  };
}

// Opportunistic cleanup, ~1 request in 100. TS-194: windows older than two days are never read again
// (the rolling 24-hour email counts read back 25 hourly windows, so one day was too soon).
function pruneOldCounters(): void {
  if (Math.random() >= 0.01) return;
  pool
    .query(`DELETE FROM "rate_limit_counters" WHERE "windowStart" < (now() AT TIME ZONE 'UTC') - interval '2 days'`)
    .catch(() => {});
}

// TS-163: counts one hit against `key` in the current window and returns the new count -- for a
// limit with more than one threshold (the daily email ceiling, with headroom for password resets).
// TS-186: and the window it was counted in, for undoRateLimitHit.
// TS-203: a day or more rolls, like hitRateLimit (the count is then the rolling total).
export async function hitRateLimitCount(key: string, windowSeconds: number): Promise<{ count: number; windowStart: Date }> {
  if (rolls(windowSeconds)) {
    const { windowStart, total } = await hitRolling(key, windowSeconds, Date.now());
    return { count: total, windowStart };
  }
  const windowStart = windowStartFor(Date.now(), windowSeconds * 1000);
  const { rows } = await pool.query<{ count: number }>(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2::timestamp, 1)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = "rate_limit_counters".count + 1
     RETURNING count`,
    [key, utc(windowStart)]
  );
  return { count: rows[0].count, windowStart };
}

// TS-113: how many hits `key` already has in the current window, without adding one -- for limits
// that only count failures (a failed sign-in), so the check happens before the attempt and the
// count only goes up if it fails.
export async function peekRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const nowMs = Date.now();
  if (rolls(windowSeconds)) {
    // TS-203: a day or more rolls (see rolls()).
    const windowStart = windowStartFor(nowMs, ROLLING_BUCKET_SECONDS * 1000);
    const windows = await rollingWindows(key, windowStart, windowSeconds);
    const current = windows.find((w) => w.startMs === windowStart.getTime())?.count ?? 0;
    const earlier = windows.filter((w) => w.startMs !== windowStart.getTime());
    return {
      allowed: rollingTotal(current, earlier, windowStart.getTime(), windowSeconds) < limit,
      retryAfterSeconds: rollingRetryAfterSeconds({ windows, limit, nowMs, spanSeconds: windowSeconds }),
      windowStart,
    };
  }
  const windowMs = windowSeconds * 1000;
  const windowStart = windowStartFor(nowMs, windowMs);
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2::timestamp`,
    [key, utc(windowStart)]
  );
  const current = rows[0]?.count ?? 0;
  const previous = await previousWindowCount(key, windowStart, windowMs);
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
  // TS-203: for a rolling limit, "the current window" is the current hour.
  const start = windowStart ?? windowStartFor(Date.now(), bucketMsFor(windowSeconds));
  await pool.query(
    `UPDATE "rate_limit_counters" SET count = GREATEST(count - 1, 0) WHERE key = $1 AND "windowStart" = $2::timestamp`,
    [key, utc(start)]
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
    // TS-194: with the app's time limits, like every other transaction (see beginTransaction).
    await beginTransaction(client);
    // One claim at a time per key, so two requests at the same moment can't both be first.
    await client.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [COOLDOWN_LOCK_SPACE, key]);
    const nowMs = Date.now();
    const { rows } = await client.query<{ startMs: number }>(
      `SELECT (EXTRACT(EPOCH FROM "windowStart") * 1000)::float8 AS "startMs" FROM "rate_limit_counters"
        WHERE key = $1 AND count > 0 AND "windowStart" > $2::timestamp
        ORDER BY "windowStart" DESC LIMIT 1`,
      [key, utc(new Date(nowMs - seconds * 1000))]
    );
    if (rows[0]) {
      await client.query("COMMIT");
      const endsMs = Number(rows[0].startMs) + seconds * 1000;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((endsMs - nowMs) / 1000)), claimedAt: null };
    }
    const claimedAt = new Date(nowMs);
    await client.query(
      `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2::timestamp, 1)
       ON CONFLICT (key, "windowStart") DO UPDATE SET count = 1`,
      [key, utc(claimedAt)]
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
  await pool.query(`DELETE FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2::timestamp`, [key, utc(claimedAt)]);
}

// TS-194 (Tom's decision): Gmail's daily sending limit counts the last 24 hours, not a calendar day.
// The site-wide email counts used to start again from zero at midnight UTC, so a burst just before
// and just after midnight could send nearly twice the day's allowance inside 24 hours. They're now
// kept in hourly windows, and a count is everything in the current hour plus the 24 hours before
// it -- a little more than 24 hours, never less, so it can't come out below what Gmail sees.
export const ROLLING_BUCKET_SECONDS = 3600;
export const ROLLING_SPAN_SECONDS = 86_400;

/**
 * TS-194: the rolling total -- `currentCount` (the current hourly window, this hit included) plus
 * every earlier window that started no more than `spanSeconds` before the current one. Pure, so
 * it can be unit-tested without a database.
 */
export function rollingTotal(
  currentCount: number,
  earlier: { startMs: number; count: number }[],
  currentStartMs: number,
  spanSeconds: number = ROLLING_SPAN_SECONDS
): number {
  const oldestMs = currentStartMs - spanSeconds * 1000;
  return earlier
    .filter((w) => w.startMs >= oldestMs && w.startMs < currentStartMs)
    .reduce((total, w) => total + Number(w.count), currentCount);
}

/**
 * TS-194: counts one hit against `key` in the current hourly window and returns the rolling total
 * (see rollingTotal), with the window it was counted in -- pass that to undoRateLimitHit (with
 * ROLLING_BUCKET_SECONDS) to take exactly this hit back.
 */
export async function hitRollingCount(key: string): Promise<{ count: number; windowStart: Date }> {
  // TS-203: the same as every other rolling limit now (see hitRolling).
  const { windowStart, total } = await hitRolling(key, ROLLING_SPAN_SECONDS, Date.now());
  return { count: total, windowStart };
}
