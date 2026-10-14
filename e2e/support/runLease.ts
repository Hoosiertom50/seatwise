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

/** Takes this run's share of the lease. Never fails the run: without it, the sweep just can't tell. */
export async function takeRunLease(): Promise<void> {
  const url = resolveDatabaseUrl();
  if (!url || !isLocalDatabaseUrl(url)) return;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock_shared($1)", [RUN_LEASE_KEY]);
    // Not waiting on this connection keeps the runner from exiting early on its account.
    (client as unknown as { connection?: { stream?: { unref?: () => void } } }).connection?.stream?.unref?.();
    (globalThis as LeaseHolder)[HOLDER] = client;
  } catch {
    await client.end().catch(() => undefined);
  }
}

/** Lets go of this run's share (called by the sweep before it looks for other runs). */
export async function releaseRunLease(): Promise<void> {
  const client = (globalThis as LeaseHolder)[HOLDER];
  delete (globalThis as LeaseHolder)[HOLDER];
  await client?.end().catch(() => undefined);
}

/**
 * True when another run still holds the lease. Checked on a connection of its own: an exclusive
 * try-lock only succeeds when nobody holds a share, and is let go of at once.
 */
export async function anotherRunIsActive(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ free: boolean }>("SELECT pg_try_advisory_lock($1) AS free", [RUN_LEASE_KEY]);
    if (rows[0]?.free) await client.query("SELECT pg_advisory_unlock($1)", [RUN_LEASE_KEY]);
    return !rows[0]?.free;
  } finally {
    await client.end().catch(() => undefined);
  }
}
