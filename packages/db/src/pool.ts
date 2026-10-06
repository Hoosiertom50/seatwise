import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __seatwisePgPool: Pool | undefined;
}

// TS-180: limits for the app's own database work, so one stuck statement or a transaction left
// open can't hold locks (on a whole wedding, say) for long: a statement stops after 20 seconds,
// and a transaction left idle is ended after 30.
export const STATEMENT_TIMEOUT_MS = 20_000;
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

// TS-187: how long a request waits for a free database connection before giving up (instead of
// waiting forever when every connection is busy).
export const CONNECTION_TIMEOUT_MS = 10_000;

// TS-180: only inside the running app (Next.js sets NEXT_RUNTIME; `next start` runs as production)
// -- never for migrations (Prisma uses its own connection) or the maintenance scripts in
// packages/db/prisma, which may run long on purpose. SEATWISE_DB_TIMEOUTS=off turns them off.
const applyTimeouts =
  process.env.SEATWISE_DB_TIMEOUTS !== "off" &&
  (!!process.env.NEXT_RUNTIME || process.env.NODE_ENV === "production");

// TS-187: the limits used to be set once per connection (a session SET). Neon's pooled connection
// (PgBouncer, transaction mode) hands each transaction whichever server connection is free, so a
// session setting may not be there for the next transaction -- the limits weren't reliable. They're
// now set inside each transaction instead (SET LOCAL, see beginTransaction), which always holds.
// Optional, for production: `ALTER ROLE <app role> SET statement_timeout = '20s'` (and the same for
// idle_in_transaction_session_timeout) on the live database gives every statement the limit too,
// including the ones outside a transaction. Not needed for the app to work.
const BEGIN_WITH_LIMITS = `BEGIN; SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS / 1000}s'; SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT_MS / 1000}s'`;

/**
 * TS-187: starts a transaction on `client`, with the app's time limits (above) for every statement
 * in it and for the transaction sitting idle. Use it in place of `client.query("BEGIN")`. Outside
 * the running app (scripts, migrations) it's a plain BEGIN.
 */
export async function beginTransaction(client: { query: (text: string) => Promise<unknown> }): Promise<void> {
  await client.query(applyTimeouts ? BEGIN_WITH_LIMITS : "BEGIN");
}

function createPool(): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
}

export const pool = globalThis.__seatwisePgPool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  globalThis.__seatwisePgPool = pool;
}
