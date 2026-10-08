// TS-230 / TS-232 / TS-228: an in-memory stand-in for the few tables "Forgot password" and the
// email limits use (rate-limit counters, users, password reset links), for unit tests only. It
// answers the app's own SQL by shape, so the real counting code (rolling windows, cooldown claims,
// give-backs) runs unchanged without a database. Every statement waits a turn first, so requests
// sent "at the same moment" really interleave, and pg_advisory_xact_lock is honoured per key.

type Row = Record<string, unknown>;
type Result = { rows: Row[]; rowCount: number };

export type FakeUser = { id: string; email: string; name: string; emailVerifiedAt: Date | null; createdAt: Date };
export type FakeResetLink = { userId: string; tokenHash: string; createdAt: Date; expiresAt: Date; usedAt: Date | null };

export class FakeDatabase {
  /** rate_limit_counters, by key then window start (ms). */
  counters = new Map<string, Map<number, number>>();
  users = new Map<string, FakeUser>();
  resetLinks: FakeResetLink[] = [];
  /** Every statement run, in order (whitespace squashed). */
  log: string[] = [];
  /** Throws this statement's error instead of running it, when it returns one. */
  failWhen: (sql: string, params: unknown[]) => Error | null = () => null;
  private locks = new Map<string, Promise<void>>();

  count(key: string): number {
    let total = 0;
    for (const n of this.counters.get(key)?.values() ?? []) total += n;
    return total;
  }

  /** Sets a counter's current-hour window (rolling limits) or current window of `windowSeconds`. */
  setCount(key: string, count: number, windowSeconds = 3600): void {
    const bucket = windowSeconds >= 86_400 ? 3600 : windowSeconds;
    const start = Math.floor(Date.now() / (bucket * 1000)) * bucket * 1000;
    this.counters.set(key, new Map([[start, count]]));
  }

  addUser(email: string, { confirmed = true, createdDaysAgo = 30 }: { confirmed?: boolean; createdDaysAgo?: number } = {}): FakeUser {
    const user: FakeUser = {
      id: `user-${this.users.size + 1}`,
      email: email.toLowerCase(),
      name: "Pat Lee",
      emailVerifiedAt: confirmed ? new Date(Date.now() - 86_400_000) : null,
      createdAt: new Date(Date.now() - createdDaysAgo * 86_400_000),
    };
    this.users.set(user.id, user);
    return user;
  }

  /** Opens every link this account has (as the person clicking it would use it up). */
  useLinks(userId: string): void {
    for (const link of this.resetLinks) if (link.userId === userId && !link.usedAt) link.usedAt = new Date();
  }

  /** Installs the stand-in on the app's pool; returns a function that puts the real one back. */
  install(pool: unknown): () => void {
    const target = pool as { query: unknown; connect: unknown };
    const realQuery = target.query;
    const realConnect = target.connect;
    target.query = (sql: string, params: unknown[] = []) => this.run(sql, params, null);
    target.connect = async () => {
      const client = { held: [] as (() => void)[] };
      return {
        query: (sql: string, params: unknown[] = []) => this.run(sql, params, client),
        release: () => {},
      };
    };
    return () => {
      target.query = realQuery;
      target.connect = realConnect;
    };
  }

  private async run(sqlText: string, params: unknown[], client: { held: (() => void)[] } | null): Promise<Result> {
    await new Promise((resolve) => setImmediate(resolve));
    const sql = sqlText.replace(/\s+/g, " ").trim();
    this.log.push(sql);
    const failure = this.failWhen(sql, params);
    if (failure) throw failure;
    const done = (rows: Row[] = [], rowCount = rows.length): Result => ({ rows, rowCount });
    const time = (value: unknown) => Date.parse(String(value));

    if (/^(BEGIN|SET LOCAL)/.test(sql)) return done();
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      for (const release of client?.held.splice(0) ?? []) release();
      return done();
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      const lockKey = `${params[0]}:${params[1]}`;
      const before = this.locks.get(lockKey) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      this.locks.set(lockKey, before.then(() => mine));
      await before;
      client?.held.push(release);
      return done();
    }

    // --- rate_limit_counters ---
    if (sql.startsWith(`INSERT INTO "rate_limit_counters"`)) {
      const [key, start] = [String(params[0]), time(params[1])];
      const windows = this.counters.get(key) ?? new Map<number, number>();
      this.counters.set(key, windows);
      const next = sql.includes("SET count = 1") ? 1 : (windows.get(start) ?? 0) + 1;
      windows.set(start, next);
      return done([{ count: next }]);
    }
    if (sql.startsWith(`SELECT (EXTRACT(EPOCH FROM "windowStart") * 1000)::float8 AS "startMs" FROM "rate_limit_counters"`)) {
      // claimCooldown: the newest claim still inside the cooldown.
      const after = time(params[1]);
      const starts = [...(this.counters.get(String(params[0])) ?? new Map<number, number>()).entries()]
        .filter(([start, n]) => n > 0 && start > after)
        .map(([start]) => start)
        .sort((a, b) => b - a);
      return done(starts.length ? [{ startMs: starts[0] }] : []);
    }
    if (sql.startsWith(`SELECT (EXTRACT(EPOCH FROM "windowStart") * 1000)::float8 AS "startMs", count FROM "rate_limit_counters"`)) {
      const [from, to] = [time(params[1]), time(params[2])];
      const rows = [...(this.counters.get(String(params[0])) ?? new Map<number, number>()).entries()]
        .filter(([start]) => start >= from && start <= to)
        .map(([startMs, count]) => ({ startMs, count }));
      return done(rows);
    }
    if (sql.startsWith(`SELECT count FROM "rate_limit_counters"`)) {
      const n = this.counters.get(String(params[0]))?.get(time(params[1]));
      return done(n === undefined ? [] : [{ count: n }]);
    }
    if (sql.startsWith(`UPDATE "rate_limit_counters" SET count = GREATEST(count - 1, 0)`)) {
      const windows = this.counters.get(String(params[0]));
      const start = time(params[1]);
      if (!windows?.has(start)) return done([], 0);
      windows.set(start, Math.max(0, windows.get(start)! - 1));
      return done([], 1);
    }
    if (sql.startsWith(`DELETE FROM "rate_limit_counters" WHERE key = $1`)) {
      const removed = this.counters.get(String(params[0]))?.delete(time(params[1])) ?? false;
      return done([], removed ? 1 : 0);
    }
    if (sql.startsWith(`DELETE FROM "rate_limit_counters"`)) return done();

    // --- users ---
    if (/FROM "users" WHERE email = \$1$/.test(sql)) {
      const user = [...this.users.values()].find((u) => u.email === String(params[0]));
      return done(user ? [{ ...user, passwordHash: "x", sessionVersion: 0, updatedAt: user.createdAt }] : []);
    }
    // TS-248: a signed-in request (getAuthSession) -- the account by id, and no ended sessions.
    if (/^SELECT id, email, .* FROM "users" WHERE id = \$1$/.test(sql)) {
      const user = this.users.get(String(params[0]));
      return done(user ? [{ ...user, passwordHash: "x", sessionVersion: 0, updatedAt: user.createdAt }] : []);
    }
    if (sql.startsWith(`SELECT 1 FROM "revoked_sessions"`)) return done();
    if (sql.startsWith(`SELECT "createdAt" > now() - make_interval(days => $2) AS "isNew" FROM "users"`)) {
      const user = this.users.get(String(params[0]));
      return done(user ? [{ isNew: user.createdAt.getTime() > Date.now() - Number(params[1]) * 86_400_000 }] : []);
    }

    // --- password_reset_tokens ---
    if (sql.startsWith(`INSERT INTO "password_reset_tokens"`)) {
      const now = Date.now();
      this.resetLinks.push({
        userId: String(params[1]),
        tokenHash: String(params[2]),
        createdAt: new Date(now),
        expiresAt: new Date(now + Number(params[3]) * 60_000),
        usedAt: null,
      });
      return done([], 1);
    }
    if (sql.startsWith(`SELECT 1 FROM "password_reset_tokens" WHERE "userId" = $1`)) {
      const usable = this.resetLinks.some((l) => l.userId === params[0] && !l.usedAt && l.expiresAt.getTime() > Date.now());
      return done(usable ? [{ "?column?": 1 }] : []);
    }
    if (sql.startsWith(`SELECT max("createdAt") AS last FROM "password_reset_tokens"`)) {
      const times = this.resetLinks
        .filter((l) => l.userId === params[0] && l.createdAt.getTime() > Date.now() - 86_400_000)
        .map((l) => l.createdAt.getTime());
      return done([{ last: times.length ? new Date(Math.max(...times)) : null }]);
    }
    if (sql.startsWith(`UPDATE "password_reset_tokens" SET "usedAt" = now() WHERE "userId" = $1 AND "usedAt" IS NULL AND "tokenHash" <> $2`)) {
      const kept = this.resetLinks.find((l) => l.tokenHash === params[1]);
      let n = 0;
      for (const l of this.resetLinks) {
        if (l.userId === params[0] && !l.usedAt && l.tokenHash !== params[1] && kept && l.createdAt < kept.createdAt) {
          l.usedAt = new Date();
          n++;
        }
      }
      return done([], n);
    }
    if (sql.startsWith(`UPDATE "password_reset_tokens" SET "usedAt" = now() WHERE "tokenHash" = $1`)) {
      // TS-253: an unsent link marked used (when it couldn't be deleted).
      let n = 0;
      for (const l of this.resetLinks) {
        if (l.tokenHash === params[0] && !l.usedAt) {
          l.usedAt = new Date();
          n++;
        }
      }
      return done([], n);
    }
    if (sql.startsWith(`DELETE FROM "password_reset_tokens" WHERE "tokenHash" = $1`)) {
      const before = this.resetLinks.length;
      this.resetLinks = this.resetLinks.filter((l) => !(l.tokenHash === params[0] && !l.usedAt));
      return done([], before - this.resetLinks.length);
    }
    if (sql.startsWith(`DELETE FROM "password_reset_tokens"`)) return done();

    throw new Error(`FakeDatabase: no stand-in for: ${sql.slice(0, 160)}`);
  }
}
