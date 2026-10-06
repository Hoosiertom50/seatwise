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

// TS-180: only inside the running app (Next.js sets NEXT_RUNTIME; `next start` runs as production)
// -- never for migrations (Prisma uses its own connection) or the maintenance scripts in
// packages/db/prisma, which may run long on purpose. SEATWISE_DB_TIMEOUTS=off turns them off.
const applyTimeouts =
  process.env.SEATWISE_DB_TIMEOUTS !== "off" &&
  (!!process.env.NEXT_RUNTIME || process.env.NODE_ENV === "production");

function createPool(): Pool {
  const created = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  if (applyTimeouts) {
    // Set on each new connection rather than as connection-string options: Neon's pooled
    // connection (PgBouncer) refuses startup settings like statement_timeout outright, which
    // would stop every connection. A SET sent first is queued ahead of the connection's first query.
    created.on("connect", (client) => {
      client
        .query(
          `SET statement_timeout = ${STATEMENT_TIMEOUT_MS}; SET idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS}`
        )
        .catch(() => {
          // A connection that can't take the settings still works -- just without the limits.
        });
    });
  }
  return created;
}

export const pool = globalThis.__seatwisePgPool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  globalThis.__seatwisePgPool = pool;
}
