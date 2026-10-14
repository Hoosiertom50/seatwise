// Review 15 (D4): a manual move is checked against the moving guest as they are once it holds the
// plan's lock -- their party size, their accessible-table need and their must-sit group. It used to
// check the copy it read before waiting for the lock, so a party size raised, an accessible need
// set or a must-sit rule added meanwhile (none of which moves the plan's revision) let the move go
// through over the table's seats, to a table that isn't accessible, or splitting the pair. On the
// local database: the plan's lock is held from outside while the move waits, the change is made,
// and the lock let go. Run with `pnpm --filter @seatwise/web test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";

const db = await import("@seatwise/db");
const { pool, moveGuestAssignment } = db;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function localDatabaseUrl(): string | null {
  let url = process.env.DATABASE_URL;
  if (!url) {
    try {
      const env = readFileSync(path.join(import.meta.dirname, "../../../../packages/db/.env"), "utf8");
      url = /^DATABASE_URL="?([^"\n]+)"?/m.exec(env)?.[1];
    } catch {
      return null;
    }
  }
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!LOCAL_HOSTS.has(parsed.hostname)) return null;
    parsed.searchParams.delete("schema");
    return parsed.toString();
  } catch {
    return null;
  }
}

type Rows = Record<string, unknown>[];
type PgClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Rows; rowCount: number | null }>;
  connect: () => Promise<void>;
  end: () => Promise<void>;
};
type PgPool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Rows; rowCount: number | null }>;
  connect: () => Promise<unknown>;
  end: () => Promise<void>;
};
const pg = createRequire(import.meta.url)("pg") as {
  Client: new (o: { connectionString: string; connectionTimeoutMillis: number }) => PgClient;
  Pool: new (o: { connectionString: string; max: number }) => PgPool;
};
const localUrl = localDatabaseUrl();

async function localClient(): Promise<PgClient> {
  const client = new pg.Client({ connectionString: localUrl!, connectionTimeoutMillis: 2000 });
  await client.connect();
  return client;
}
async function skipReason(): Promise<string | false> {
  if (!localUrl) return "no local database configured (DATABASE_URL must point at localhost)";
  try {
    const c = await localClient();
    try {
      await c.query(`SELECT 1 FROM "plan_versions" LIMIT 0`);
    } finally {
      await c.end();
    }
    return false;
  } catch (err) {
    return `local database not reachable (${(err as Error & { code?: string }).code ?? (err as Error).message})`;
  }
}
const skip = await skipReason();

// The app's own queries go to the local database for these tests.
const appPool = localUrl ? new pg.Pool({ connectionString: localUrl, max: 4 }) : null;
if (appPool) {
  (pool as unknown as { query: unknown }).query = appPool.query.bind(appPool);
  (pool as unknown as { connect: unknown }).connect = appPool.connect.bind(appPool);
}
after(async () => {
  await appPool?.end().catch(() => {});
});

/** A wedding: Ann, Bea, Cy at Table A (4 seats, not accessible); Xavier and Yara at Table B. */
async function weddingWithAFullishTable(setup: PgClient) {
  const ownerId = randomUUID();
  const weddingId = randomUUID();
  const planId = randomUUID();
  const tableA = randomUUID();
  const tableB = randomUUID();
  const guest: Record<string, string> = {};
  await setup.query(`INSERT INTO "users" (id, email, "passwordHash", name, "updatedAt") VALUES ($1, $2, 'x', 'Review 15 test', now())`, [
    ownerId,
    `r15-${ownerId}@example.invalid`,
  ]);
  await setup.query(`INSERT INTO "weddings" (id, "ownerId", name, "updatedAt") VALUES ($1, $2, 'Review 15 test', now())`, [weddingId, ownerId]);
  await setup.query(
    `INSERT INTO "seating_tables" (id, "weddingId", label, capacity, "isAccessible", "updatedAt")
     VALUES ($1, $3, 'Table A', 4, false, now()), ($2, $3, 'Table B', 10, true, now())`,
    [tableA, tableB, weddingId]
  );
  await setup.query(`INSERT INTO "plan_versions" (id, "weddingId", "versionNumber", "isCurrent") VALUES ($1, $2, 1, true)`, [planId, weddingId]);
  for (const [name, table] of [["Ann", tableA], ["Bea", tableA], ["Cy", tableA], ["Xavier", tableB], ["Yara", tableB]] as const) {
    guest[name] = randomUUID();
    await setup.query(`INSERT INTO "guests" (id, "weddingId", "firstName", "lastName", "updatedAt") VALUES ($1, $2, $3, 'Race', now())`, [
      guest[name],
      weddingId,
      name,
    ]);
    await setup.query(
      `INSERT INTO "seat_assignments" (id, "planVersionId", "guestId", "seatingTableId", "updatedAt") VALUES ($1, $2, $3, $4, now())`,
      [randomUUID(), planId, guest[name], table]
    );
  }
  return { ownerId, weddingId, planId, tableA, tableB, guest };
}

/** Holds the plan's lock (as an edit does), starts the move, makes `change` while it waits, lets go. */
async function moveWhileChanged(
  w: Awaited<ReturnType<typeof weddingWithAFullishTable>>,
  change: (c: PgClient) => Promise<void>
) {
  const holder = await localClient();
  const other = await localClient();
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT id FROM "plan_versions" WHERE id = $1 FOR NO KEY UPDATE`, [w.planId]);
    const { rows } = await holder.query(`SELECT pg_backend_pid() AS pid`);
    const holderPid = rows[0].pid as number;
    const moving = moveGuestAssignment(w.planId, w.weddingId, w.guest.Xavier, w.tableA, w.ownerId).then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, message: e.message })
    );
    // Wait until the move (its first checks done) is waiting on the plan.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows: waiting } = await other.query(`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [holderPid]);
      if ((waiting[0].n as number) >= 1) break;
      assert.ok(Date.now() < deadline, "the move never waited on the plan");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await change(other);
    await holder.query("ROLLBACK");
    return await moving;
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await holder.end().catch(() => {});
    await other.end().catch(() => {});
  }
}

async function seatsAt(c: PgClient, planId: string, tableId: string): Promise<{ guests: string[]; seats: number; flagged: number }> {
  const { rows } = await c.query(
    `SELECT g."firstName" AS name, g.headcount, sa."needsReassignment" AS flagged FROM "seat_assignments" sa JOIN "guests" g ON g.id = sa."guestId"
     WHERE sa."planVersionId" = $1 AND sa."seatingTableId" = $2 ORDER BY g."firstName"`,
    [planId, tableId]
  );
  return {
    guests: rows.map((r) => r.name as string),
    seats: rows.reduce((n, r) => n + (r.headcount as number), 0),
    flagged: rows.filter((r) => r.flagged).length,
  };
}

async function withWedding(fn: (w: Awaited<ReturnType<typeof weddingWithAFullishTable>>, setup: PgClient) => Promise<void>) {
  const setup = await localClient();
  let w: Awaited<ReturnType<typeof weddingWithAFullishTable>> | undefined;
  try {
    w = await weddingWithAFullishTable(setup);
    await fn(w, setup);
  } finally {
    if (w) {
      await setup.query(`DELETE FROM "weddings" WHERE id = $1`, [w.weddingId]).catch(() => {});
      await setup.query(`DELETE FROM "users" WHERE id = $1`, [w.ownerId]).catch(() => {});
    }
    await setup.end().catch(() => {});
  }
}

test("Review 15: a party size raised while a move waits is checked -- the move is refused, the table not overfilled", { skip }, async () => {
  await withWedding(async (w, setup) => {
    const result = await moveWhileChanged(w, (c) => c.query(`UPDATE "guests" SET headcount = 3 WHERE id = $1`, [w.guest.Xavier]).then(() => {}));
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /only has 1 seat\(s\) left, but 3 are needed/);
    assert.deepEqual(await seatsAt(setup, w.planId, w.tableA), { guests: ["Ann", "Bea", "Cy"], seats: 3, flagged: 0 });
  });
});

test("Review 15: an accessible-table need set while a move waits is checked -- the move is refused", { skip }, async () => {
  await withWedding(async (w, setup) => {
    const result = await moveWhileChanged(w, (c) =>
      c.query(`UPDATE "guests" SET "requiresAccessibleTable" = true WHERE id = $1`, [w.guest.Xavier]).then(() => {})
    );
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /requires an accessible table/);
    assert.deepEqual((await seatsAt(setup, w.planId, w.tableA)).guests, ["Ann", "Bea", "Cy"]);
  });
});

test("Review 15: a must-sit rule added while a move waits is checked -- the move is refused, the pair not split", { skip }, async () => {
  await withWedding(async (w, setup) => {
    const result = await moveWhileChanged(w, (c) =>
      c
        .query(`INSERT INTO "guest_relationships" (id, "weddingId", "guestAId", "guestBId", type) VALUES ($1, $2, $3, $4, 'MUST_SIT_TOGETHER')`, [
          randomUUID(),
          w.weddingId,
          w.guest.Xavier,
          w.guest.Yara,
        ])
        .then(() => {})
    );
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /must-sit-together group changed/);
    assert.deepEqual((await seatsAt(setup, w.planId, w.tableB)).guests, ["Xavier", "Yara"]);
  });
});
