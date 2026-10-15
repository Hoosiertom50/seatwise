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
  on: (event: "error", listener: () => void) => void;
  connection?: { stream?: { unref?: () => void } };
};

const url = localDatabaseUrl();
if (url) {
  const pg = createRequire(import.meta.url)("pg") as {
    Client: new (o: { connectionString: string; connectionTimeoutMillis: number; application_name: string }) => Client;
  };
  // Named, so the lease can be seen in pg_stat_activity.
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000, application_name: "seatwise-unit-test-lease" });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock_shared($1)", [RUN_LEASE_KEY]);
    // Held until the process ends; not waited on, so the tests' process still ends on its own.
    client.connection?.stream?.unref?.();
  } catch {
    // No reachable local database: the tests that need one skip themselves.
    await client.end().catch(() => undefined);
  }
}
