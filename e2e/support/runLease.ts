// Review 14: a test run's end-of-run sweep (globalTeardown.ts) deletes every test account and
// marker-tagged wedding -- including those of another run still going against the same local
// database, which then found itself signed out mid-test ("session has expired"). Each run now holds
// a shared Postgres advisory lock for as long as it runs (taken in globalSetup); the sweep only goes
// ahead if, once this run has let go of its own, no other run holds one. The lock belongs to this
// process's database connection, so a run that crashes lets go of it by itself.
//
// globalSetup and globalTeardown run in the same Playwright runner process, so the connection is
// kept on globalThis between them.

import { Client } from "pg";
import { isLocalDatabaseUrl } from "./productionGuard";
import { resolveDatabaseUrl } from "./testDatabase";

/** An arbitrary fixed key: "a Seatwise e2e run is using this database". */
export const RUN_LEASE_KEY = 72_601_414;
const HOLDER = Symbol.for("seatwise.e2e.runLease");
const LOST = Symbol.for("seatwise.e2e.runLeaseLost");

type LeaseHolder = { [HOLDER]?: Client; [LOST]?: string };

/** The lease connection's socket (pg keeps it on client.connection.stream). */
function leaseSocket(client: Client): { ref?: () => void; unref?: () => void } | undefined {
  return (client as unknown as { connection?: { stream?: { ref?: () => void; unref?: () => void } } }).connection?.stream;
}

/**
 * Takes this run's share of the lease. PR #115 review: a local database it can't be taken on stops
 * the run before any test -- it used to go on unprotected, and another run's sweep could then delete
 * this run's accounts as it used them.
 */
export async function takeRunLease(): Promise<void> {
  const url = resolveDatabaseUrl();
  if (!url || !isLocalDatabaseUrl(url)) return;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  // Review 15: a connection the database ends (a restart, pg_terminate_backend) mustn't crash the
  // whole run with no report. PR #115 review: it's noted instead, and the run's teardown fails the
  // run with the reason (see leaseLostMessage) -- another run's sweep could have deleted this run's
  // accounts meanwhile, so its results can't be trusted.
  client.on("error", (err) => {
    (globalThis as LeaseHolder)[LOST] ??= err.message;
  });
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock_shared($1)", [RUN_LEASE_KEY]);
  } catch (err) {
    await client.end().catch(() => undefined);
    throw new Error(
      `Couldn't take this test run's hold on the local database (${err instanceof Error ? err.message : String(err)}). ` +
        "Is the database running? Without the hold, another run's cleanup could delete this run's test accounts."
    );
  }
  // Not waiting on this connection keeps the runner from staying alive on its account if the run
  // ends without its teardown. (releaseRunLease hooks it back in before closing it.)
  leaseSocket(client)?.unref?.();
  (globalThis as LeaseHolder)[HOLDER] = client;
}

/** PR #115 review: why this run lost its share part-way (its connection ended), or null if it didn't. */
export function leaseLostMessage(): string | null {
  const lost = (globalThis as LeaseHolder)[LOST];
  return lost === undefined
    ? null
    : `This test run lost its hold on the local database part-way (${lost}), so another run's cleanup may have deleted its test accounts mid-test. Run it again.`;
}

/** Lets go of this run's share (called by the sweep before it looks for other runs). */
export async function releaseRunLease(): Promise<void> {
  const client = (globalThis as LeaseHolder)[HOLDER];
  delete (globalThis as LeaseHolder)[HOLDER];
  if (!client) return;
  // Closing it ourselves isn't losing it.
  client.removeAllListeners("error");
  client.on("error", () => undefined);
  // Review 15: hooked back in first -- waiting to close an unhooked connection was all that was left,
  // so Node ended the run in the middle of its teardown with exit code 0, before the results and
  // reports were written (a run with failed tests looked like a pass).
  leaseSocket(client)?.ref?.();
  await client.end().catch(() => undefined);
}

/**
 * The sweep's turn: the lease taken exclusively, on a connection of its own, or null when another
 * run still holds a share. PR #115 review: held for the whole sweep and let go of afterwards
 * (`release`) -- let go of at once, a run starting in between took its share, signed up its
 * accounts, and the sweep still going deleted them. A run starting during the sweep now waits for it.
 * The sweep runs its queries on `client`, the connection holding the lock: if that connection ends,
 * the lock is gone and so is the sweep (its next query fails) -- it can't go on unprotected.
 */
export type SweepTurn = { client: Client; release: () => Promise<void> };
export async function takeSweepTurn(connectionString: string): Promise<SweepTurn | null> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const { rows } = await client.query<{ free: boolean }>("SELECT pg_try_advisory_lock($1) AS free", [RUN_LEASE_KEY]);
    if (!rows[0]?.free) {
      await client.end().catch(() => undefined);
      return null;
    }
    return {
      client,
      release: async () => {
        await client.query("SELECT pg_advisory_unlock($1)", [RUN_LEASE_KEY]).catch(() => undefined);
        await client.end().catch(() => undefined);
      },
    };
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
}

/** The web unit tests' lease connections are named this (apps/web/src/lib/test-run-lease.mts). */
const UNIT_TEST_LEASE_NAME = "seatwise-unit-test-lease ";

/**
 * Review 16 (PR #116 review): the sweep's turn when only unit-test processes hold a share. Unit-test
 * files end within minutes and never sweep -- skipping, as for another browser run, left this run's
 * accounts and weddings behind until a later run. So it waits for them (up to `waitMs`), while a
 * browser run's share still means "skip, that run sweeps when it ends". Null when another browser
 * run holds a share, or the wait ran out.
 */
export async function takeSweepTurnAfterUnitTests(connectionString: string, waitMs = 5 * 60_000): Promise<SweepTurn | null> {
  const turn = await takeSweepTurn(connectionString);
  if (turn) return turn;
  const client = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const { rows } = await client.query<{ name: string | null }>(
      `SELECT a.application_name AS name FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory' AND l.objid = $1 AND l.mode = 'ShareLock' AND l.granted`,
      [RUN_LEASE_KEY]
    );
    if (rows.length === 0 || !rows.every((r) => r.name?.startsWith(UNIT_TEST_LEASE_NAME))) {
      await client.end().catch(() => undefined);
      return null;
    }
    // Waiting for the lock also holds back new shares (Postgres queues them behind it), so a unit-test
    // file or browser run starting meanwhile waits for the sweep, as with takeSweepTurn.
    await client.query(`SET lock_timeout = ${Math.max(1, Math.round(waitMs))}`);
    await client.query("SELECT pg_advisory_lock($1)", [RUN_LEASE_KEY]);
    await client.query("SET lock_timeout = 0");
    return {
      client,
      release: async () => {
        await client.query("SELECT pg_advisory_unlock($1)", [RUN_LEASE_KEY]).catch(() => undefined);
        await client.end().catch(() => undefined);
      },
    };
  } catch {
    // The wait ran out (lock_timeout), or the connection failed: no turn this time.
    await client.end().catch(() => undefined);
    return null;
  }
}
