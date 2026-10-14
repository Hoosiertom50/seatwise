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
