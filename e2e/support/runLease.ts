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

type LeaseHolder = { [HOLDER]?: Client };

/** The lease connection's socket (pg keeps it on client.connection.stream). */
function leaseSocket(client: Client): { ref?: () => void; unref?: () => void } | undefined {
  return (client as unknown as { connection?: { stream?: { ref?: () => void; unref?: () => void } } }).connection?.stream;
}

/** Takes this run's share of the lease. Never fails the run: without it, the sweep just can't tell. */
export async function takeRunLease(): Promise<void> {
  const url = resolveDatabaseUrl();
  if (!url || !isLocalDatabaseUrl(url)) return;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  // Review 15: a connection the database ends (a restart, pg_terminate_backend) is just a lease let
  // go of -- unhandled, its error crashed the whole run with no report.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock_shared($1)", [RUN_LEASE_KEY]);
    // Not waiting on this connection keeps the runner from staying alive on its account if the run
    // ends without its teardown. (releaseRunLease hooks it back in before closing it.)
    leaseSocket(client)?.unref?.();
    (globalThis as LeaseHolder)[HOLDER] = client;
  } catch {
    await client.end().catch(() => undefined);
  }
}

/** Lets go of this run's share (called by the sweep before it looks for other runs). */
export async function releaseRunLease(): Promise<void> {
  const client = (globalThis as LeaseHolder)[HOLDER];
  delete (globalThis as LeaseHolder)[HOLDER];
  if (!client) return;
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
 */
export async function takeSweepTurn(connectionString: string): Promise<{ release: () => Promise<void> } | null> {
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
