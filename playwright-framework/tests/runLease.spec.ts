// Review 15 — the e2e "run in progress" lease (e2e/support/runLease.ts). Letting go of it once made a
// whole test run end in the middle of its teardown with exit code 0, before its results were
// written: the lease connection was unhooked from Node's event loop, so while it closed nothing kept
// the process alive. This runs the take-and-let-go as its own process and checks it gets to the end.
// Needs the local database; skipped without one (e.g. a framework-only run with no Postgres).
import { spawnSync } from "node:child_process";
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
  await other.connect();
  try {
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
