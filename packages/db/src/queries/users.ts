import { randomUUID } from "crypto";
import { pool } from "../pool";

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  // TS-155
  sessionVersion: number;
  // TS-164: null until the owner confirms their address.
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function createUser(input: {
  email: string;
  passwordHash: string;
  name: string;
}): Promise<UserRow> {
  const id = randomUUID();
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO "users" (id, email, "passwordHash", name, "updatedAt")
     VALUES ($1, $2, $3, $4, now())
     RETURNING id, email, "passwordHash", name, "sessionVersion", "emailVerifiedAt", "createdAt", "updatedAt"`,
    [id, input.email.toLowerCase(), input.passwordHash, input.name]
  );
  return rows[0];
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT id, email, "passwordHash", name, "sessionVersion", "emailVerifiedAt", "createdAt", "updatedAt"
     FROM "users" WHERE email = $1`,
    [email.toLowerCase()]
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT id, email, "passwordHash", name, "sessionVersion", "emailVerifiedAt", "createdAt", "updatedAt"
     FROM "users" WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

// TS-155: ends every session this account has (each token carries the version it was issued
// with). Returns the new version, for the token that replaces them.
export async function bumpSessionVersion(id: string): Promise<number | null> {
  const { rows } = await pool.query<{ sessionVersion: number }>(
    `UPDATE "users" SET "sessionVersion" = "sessionVersion" + 1 WHERE id = $1 RETURNING "sessionVersion"`,
    [id]
  );
  return rows[0]?.sessionVersion ?? null;
}
