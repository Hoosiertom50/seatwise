import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __seatwisePgPool: Pool | undefined;
}

export const pool =
  globalThis.__seatwisePgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__seatwisePgPool = pool;
}
