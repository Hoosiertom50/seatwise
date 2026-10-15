// Review 15 — the e2e "run in progress" lease (e2e/support/runLease.ts). Letting go of it once made a
// whole test run end in the middle of its teardown with exit code 0, before its results were
// written: the lease connection was unhooked from Node's event loop, so while it closed nothing kept
// the process alive. This runs the take-and-let-go as its own process and checks it gets to the end.
// Needs the local database; skipped without one (e.g. a framework-only run with no Postgres).
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";
import { test, expect } from "@playwright/test";
import { isLocalDatabaseUrl } from "../../e2e/support/productionGuard";
import { resolveDatabaseUrl } from "../../e2e/support/testDatabase";

const REPO_ROOT = resolve(process.cwd());
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const SCRIPT = resolve(REPO_ROOT, "playwright-framework/tests/fixtures/leaseRoundTrip.ts");

async function localDatabaseReachable(): Promise<boolean> {
  const url = resolveDatabaseUrl();
  if (!url || !isLocalDatabaseUrl(url)) return false;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

test("letting go of the run lease doesn't end the process before it finishes", async () => {
  test.skip(!(await localDatabaseReachable()), "no local database to hold the lease on");
  const result = spawnSync(TSX_BIN, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf-8", timeout: 30_000, env: process.env });
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).toBe("released");
  expect(result.status).toBe(0);
});

// PR #115 review: the sweep keeps its turn (the lease taken exclusively) until it lets go -- a run
// starting meanwhile can't take its share, so its accounts aren't swept as it signs them up.
test("while the sweep has its turn, a new run can't take its share of the lease", async () => {
  test.skip(!(await localDatabaseReachable()), "no local database to hold the lease on");
  const { takeSweepTurn, RUN_LEASE_KEY } = await import("../../e2e/support/runLease");
  const url = resolveDatabaseUrl()!;
  const turn = await takeSweepTurn(url);
  // A browser project in this same run (pnpm pw:test) holds a share, as it should -- nothing to check then.
  test.skip(turn === null, "a test run holds the lease (this one, with a browser project)");
  const other = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  other.on("error", () => undefined);
  try {
    // PR #115 review: connected inside the try, so a failed connection still lets go of the turn.
    await other.connect();
    const during = await other.query<{ ok: boolean }>("SELECT pg_try_advisory_lock_shared($1) AS ok", [RUN_LEASE_KEY]);
    expect(during.rows[0].ok).toBe(false);
    await turn!.release();
    const afterwards = await other.query<{ ok: boolean }>("SELECT pg_try_advisory_lock_shared($1) AS ok", [RUN_LEASE_KEY]);
    expect(afterwards.rows[0].ok).toBe(true);
    await other.query("SELECT pg_advisory_unlock_shared($1)", [RUN_LEASE_KEY]);
  } finally {
    await turn?.release();
    await other.end().catch(() => undefined);
  }
});

// PR #115 review: a local database the lease can't be taken on stops the run before any test (it used
// to go on unprotected). Nothing listens on port 1, so the connection is refused.
test("a run that can't take its share of the lease on a local database stops, saying why", () => {
  const result = spawnSync(TSX_BIN, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, DATABASE_URL: "postgresql://nobody@127.0.0.1:1/zz_no_database" },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Couldn't take this test run's hold on the local database");
  expect(result.stdout.trim()).not.toBe("released");
});

/** Ends a connection from the database's side, as a restart or pg_terminate_backend would. */
async function endFromTheDatabaseSide(url: string, pid: number): Promise<void> {
  const admin = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  admin.on("error", () => undefined);
  try {
    await admin.connect();
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

// PR #115 review: the sweep runs on the connection holding its lock -- once that connection ends (and
// with it the lock), the sweep's next query fails instead of going on unprotected.
test("once the sweep's connection ends, the sweep can't go on", async () => {
  test.skip(!(await localDatabaseReachable()), "no local database to hold the lease on");
  const { takeSweepTurn } = await import("../../e2e/support/runLease");
  const url = resolveDatabaseUrl()!;
  const turn = await takeSweepTurn(url);
  test.skip(turn === null, "a test run holds the lease (this one, with a browser project)");
  try {
    await endFromTheDatabaseSide(url, (turn!.client as unknown as { processID: number }).processID);
    await expect(turn!.client.query("SELECT 1")).rejects.toThrow();
  } finally {
    await turn?.release();
  }
});

// PR #115 review: a run whose share ends part-way is told why, so its teardown can fail the run.
test("a run whose share of the lease ends part-way is told why", async () => {
  test.skip(!(await localDatabaseReachable()), "no local database to hold the lease on");
  const { takeRunLease, releaseRunLease, leaseLostMessage } = await import("../../e2e/support/runLease");
  const url = resolveDatabaseUrl()!;
  await takeRunLease();
  try {
    expect(leaseLostMessage()).toBeNull();
    const holder = (globalThis as Record<symbol, unknown>)[Symbol.for("seatwise.e2e.runLease")] as { processID: number };
    await endFromTheDatabaseSide(url, holder.processID);
    await expect.poll(() => leaseLostMessage(), { timeout: 5_000 }).toContain("lost its hold on the local database");
  } finally {
    await releaseRunLease();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("seatwise.e2e.runLeaseLost")];
  }
});

// Review 16: the web unit tests that use the local database hold a share too (see
// apps/web/src/lib/test-run-lease.mts) -- the sweep used to delete their @example.invalid accounts
// mid-test when a browser run finished at that moment.
test("while a unit-test process runs, the sweep doesn't get its turn", async () => {
  test.skip(!(await localDatabaseReachable()), "no local database to hold the lease on");
  const { takeSweepTurn } = await import("../../e2e/support/runLease");
  const url = resolveDatabaseUrl()!;
  const before = await takeSweepTurn(url);
  test.skip(before === null, "a test run holds the lease already");
  await before!.release();
  const holder = spawn(
    TSX_BIN,
    ["--import", "./apps/web/src/lib/test-run-lease.mts", resolve(REPO_ROOT, "playwright-framework/tests/fixtures/unitTestLeaseHolder.mjs")],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: url },
    }
  );
  let holderPid = "";
  try {
    holderPid = await new Promise<string>((done, fail) => {
      holder.stdout.on("data", (chunk: Buffer) => {
        const found = /holding (\d+)/.exec(chunk.toString());
        if (found) done(found[1]);
      });
      holder.on("exit", () => fail(new Error("the stand-in unit-test process ended early")));
    });
    const during = await takeSweepTurn(url);
    await during?.release();
    expect(during).toBeNull();
  } finally {
    holder.kill();
  }
  // Its share goes with the process. PR #116 review: its own lease connection is watched -- not the
  // whole lease, which another run starting meanwhile may hold quite rightly.
  const admin = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  admin.on("error", () => undefined);
  await admin.connect();
  try {
    await expect
      .poll(async () => {
        const { rows } = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1", [`seatwise-unit-test-lease ${holderPid}`]);
        return rows.length;
      }, { timeout: 10_000 })
      .toBe(0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// PR #116 review: a unit-test process whose share ends part-way fails, saying why (as an e2e run does).
test("a unit-test process whose share of the lease ends part-way fails, saying why", async () => {
  test.skip(!(await localDatabaseReachable()), "no local database to hold the lease on");
  const url = resolveDatabaseUrl()!;
  const holder = spawn(
    TSX_BIN,
    ["--import", "./apps/web/src/lib/test-run-lease.mts", resolve(REPO_ROOT, "playwright-framework/tests/fixtures/unitTestLeaseHolder.mjs")],
    { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: url, HOLD_MS: "4000" } }
  );
  let stderr = "";
  holder.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((done) => holder.on("exit", (code) => done(code)));
  // PR #116 review: its own lease connection, by its process id -- not the newest of any test file's.
  const holderPid = await new Promise<string>((done) => {
    holder.stdout.on("data", (chunk: Buffer) => {
      const found = /holding (\d+)/.exec(chunk.toString());
      if (found) done(found[1]);
    });
  });
  const admin = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  admin.on("error", () => undefined);
  await admin.connect();
  try {
    const { rows } = await admin.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE application_name = $1",
      [`seatwise-unit-test-lease ${holderPid}`]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeTruthy();
    await admin.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
  } finally {
    await admin.end().catch(() => undefined);
  }
  expect(await exited).toBe(1);
  expect(stderr).toContain("lost its hold on the local database");
});

// PR #116 review: the sweep waits for unit-test processes (they never sweep), but not for another
// browser run (which sweeps when it ends).
test("the sweep waits for unit-test processes, but not for another browser run", async () => {
  test.skip(!(await localDatabaseReachable()), "no local database to hold the lease on");
  const { takeSweepTurn, takeSweepTurnAfterUnitTests, RUN_LEASE_KEY } = await import("../../e2e/support/runLease");
  const url = resolveDatabaseUrl()!;
  const free = await takeSweepTurn(url);
  test.skip(free === null, "a test run holds the lease already");
  await free!.release();

  // A unit-test process holding a share for about two seconds: the sweep gets its turn once it ends.
  const holder = spawn(
    TSX_BIN,
    ["--import", "./apps/web/src/lib/test-run-lease.mts", resolve(REPO_ROOT, "playwright-framework/tests/fixtures/unitTestLeaseHolder.mjs")],
    { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: url, HOLD_MS: "2000" } }
  );
  try {
    await new Promise<void>((done) => holder.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("holding") && done()));
    const started = Date.now();
    const turn = await takeSweepTurnAfterUnitTests(url, 20_000);
    await turn?.release();
    expect(turn).not.toBeNull();
    expect(Date.now() - started).toBeGreaterThan(500);
  } finally {
    holder.kill();
  }

  // A browser run's share (an unnamed connection, as takeRunLease's): no waiting, no turn.
  const browserRun = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  browserRun.on("error", () => undefined);
  await browserRun.connect();
  try {
    await browserRun.query("SELECT pg_advisory_lock_shared($1)", [RUN_LEASE_KEY]);
    const started = Date.now();
    const turn = await takeSweepTurnAfterUnitTests(url, 20_000);
    await turn?.release();
    expect(turn).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    await browserRun.end().catch(() => undefined);
  }
});

// PR #116 review: connected, but the lease can't be taken -- the test file stops rather than run
// unprotected. (A lock_timeout makes the wait for the lease fail while a sweep holds it.)
test("a unit-test process that connects but can't take its share stops", async () => {
  test.skip(!(await localDatabaseReachable()), "no local database to hold the lease on");
  const { takeSweepTurn } = await import("../../e2e/support/runLease");
  const url = resolveDatabaseUrl()!;
  const sweep = await takeSweepTurn(url);
  test.skip(sweep === null, "a test run holds the lease already");
  try {
    const withTimeout = new URL(url);
    withTimeout.searchParams.set("options", "-c lock_timeout=300");
    const result = spawnSync(
      TSX_BIN,
      ["--import", "./apps/web/src/lib/test-run-lease.mts", resolve(REPO_ROOT, "playwright-framework/tests/fixtures/unitTestLeaseHolder.mjs")],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: 30_000, env: { ...process.env, DATABASE_URL: withTimeout.toString(), HOLD_MS: "100" } }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("couldn't take its hold on the local database");
    expect(result.stdout).not.toContain("holding");
  } finally {
    await sweep!.release();
  }
});
