// Review 16: loaded into every unit-test process (see "test" in package.json). The e2e run-end sweep
// (e2e/support/globalTeardown.ts) deletes every @example.invalid account, and the unit tests that
// use the local database make such accounts too -- a browser run finishing while one of them was
// mid-test deleted its account from under it. Each test file now holds a share of the same "a test
// run is using this database" lease (e2e/support/runLease.ts, key 72601414) while it runs, so the
// sweep waits for it -- and a test file starting during a sweep waits for the sweep. The lease goes
// with the process. No local database (CI's unit job): nothing to hold.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const RUN_LEASE_KEY = 72_601_414;
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

type Client = {
  connect: () => Promise<void>;
  query: (text: string, params?: unknown[]) => Promise<unknown>;
  end: () => Promise<void>;
  on: (event: "error", listener: (err: Error) => void) => void;
  connection?: { stream?: { unref?: () => void } };
};

const url = localDatabaseUrl();
if (url) {
  const pg = createRequire(import.meta.url)("pg") as {
    Client: new (o: { connectionString: string; connectionTimeoutMillis: number; application_name: string }) => Client;
  };
  // Named, with this process's id, so each test file's lease can be seen in pg_stat_activity.
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000, application_name: `seatwise-unit-test-lease ${process.pid}` });
  let held = false;
  // Review 16 (PR #116 review): a lease lost once held (the database restarted, or the connection
  // was ended) fails this test file with the reason, as an e2e run that loses its lease does -- a
  // sweep could have deleted its accounts meanwhile. Before it's held, an error is just "no local
  // database" (below).
  client.on("error", (err: Error) => {
    if (!held) return;
    console.error(`This test file lost its hold on the local database part-way (${err.message}), so a browser run's cleanup may have deleted its test accounts mid-test. Run it again.`);
    process.exitCode = 1;
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    // Review 17: says so when a browser run's cleanup has the lease -- the wait looked like a hang.
    const free = (await client.query("SELECT pg_try_advisory_lock_shared($1) AS ok", [RUN_LEASE_KEY])) as { rows: { ok: boolean }[] };
    if (!free.rows[0]?.ok) {
      console.error("Waiting for a browser test run's cleanup of the local database to finish...");
      await client.query("SELECT pg_advisory_lock_shared($1)", [RUN_LEASE_KEY]);
    }
    held = true;
    // Held until the process ends; not waited on, so the tests' process still ends on its own.
    client.connection?.stream?.unref?.();
  } catch (err) {
    await client.end().catch(() => undefined);
    // PR #116 review: the database is there but the lease couldn't be taken -- the tests would run
    // unprotected while a sweep deletes their accounts, so this test file stops instead.
    if (connected) {
      console.error(`This test file couldn't take its hold on the local database (${err instanceof Error ? err.message : String(err)}), so it doesn't run. Run it again.`);
      process.exit(1);
    }
    // No reachable local database: the tests that need one skip themselves.
  }
}
