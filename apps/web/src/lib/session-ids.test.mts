// TS-204: unit tests for per-session ids ("Log out" ends this device only), and for /auth/me saying
// why there's no session (a retried "Delete my account" counts as done only for ACCOUNT_GONE). The
// database is replaced by a stand-in, and a throwaway secret is set before lib/auth loads. Run with
// `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.JWT_SECRET = randomBytes(32).toString("hex");

const { signToken, verifyToken, AUTH_TOKEN_TTL_SECONDS } = await import("./auth");
const { getAuthSession } = await import("./session");
const { pool } = await import("@seatwise/db");
const { NextRequest } = await import("next/server");
const { GET: getMe } = await import("../app/api/v1/auth/me/route");

const realQuery = pool.query.bind(pool);
afterEach(() => {
  (pool as unknown as { query: unknown }).query = realQuery;
});

/** The database as a stand-in: which accounts exist (with their session version) and which sessions were ended. */
function fakeDatabase(users: Record<string, number>, revoked: string[] = []) {
  (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
    if (/FROM "users"/.test(sql)) {
      const id = params[0] as string;
      return {
        rows: id in users ? [{ id, email: `${id}@example.invalid`, name: id, passwordHash: "x", sessionVersion: users[id], emailVerifiedAt: null }] : [],
      };
    }
    if (/FROM "revoked_sessions"/.test(sql)) return { rows: revoked.includes(params[0] as string) ? [{ "?column?": 1 }] : [] };
    throw new Error(`unexpected query: ${sql}`);
  };
}

const bearer = (token: string) => new NextRequest("http://localhost/api/v1/auth/me", { headers: { authorization: `Bearer ${token}` } });

test("every new session gets its own id, and renewing keeps it", async () => {
  const a = await verifyToken(await signToken({ sub: "u1", email: "u1@example.invalid" }));
  const b = await verifyToken(await signToken({ sub: "u1", email: "u1@example.invalid" }));
  assert.ok(a?.sessionId && b?.sessionId);
  assert.notEqual(a.sessionId, b.sessionId);
  // proxy.ts renews with the same claims, sessionId included.
  const renewed = await verifyToken(
    await signToken({ sub: "u1", email: "u1@example.invalid", authTime: a.authTime, sessionVersion: a.sessionVersion, sessionId: a.sessionId })
  );
  assert.equal(renewed?.sessionId, a.sessionId);
  assert.ok(Math.abs((a.expiresAt - a.issuedAt) - AUTH_TOKEN_TTL_SECONDS) <= 1);
});

test("a session ended with 'Log out' is refused; another session of the same account isn't", async () => {
  const here = await signToken({ sub: "u1", email: "u1@example.invalid" });
  const elsewhere = await signToken({ sub: "u1", email: "u1@example.invalid" });
  const hereId = (await verifyToken(here))!.sessionId!;
  fakeDatabase({ u1: 0 }, [hereId]);
  const ended = await getAuthSession(bearer(here));
  assert.equal(ended.user, null);
  assert.equal(!ended.user && ended.reason, "SESSION_ENDED");
  const other = await getAuthSession(bearer(elsewhere));
  assert.equal(other.user?.id, "u1");
});

test("'Log out on all devices' (a newer session version) ends every session", async () => {
  const token = await signToken({ sub: "u1", email: "u1@example.invalid", sessionVersion: 2 });
  fakeDatabase({ u1: 3 });
  const s = await getAuthSession(bearer(token));
  assert.equal(!s.user && s.reason, "SESSION_ENDED");
});

test("/auth/me says why there's no session: no token, session ended, account gone", async () => {
  fakeDatabase({ u1: 1 });
  const noToken = await getMe(new NextRequest("http://localhost/api/v1/auth/me"));
  assert.equal(noToken.status, 401);
  assert.equal((await noToken.json()).code, "NO_SESSION");

  const ended = await getMe(bearer(await signToken({ sub: "u1", email: "u1@example.invalid", sessionVersion: 0 })));
  assert.equal(ended.status, 401);
  assert.equal((await ended.json()).code, "SESSION_ENDED");

  const gone = await getMe(bearer(await signToken({ sub: "deleted-user", email: "d@example.invalid" })));
  assert.equal(gone.status, 401);
  assert.equal((await gone.json()).code, "ACCOUNT_GONE");

  const fine = await getMe(bearer(await signToken({ sub: "u1", email: "u1@example.invalid", sessionVersion: 1 })));
  assert.equal(fine.status, 200);
});

test("a token signed with another secret is just 'no session', never 'account gone'", async () => {
  fakeDatabase({});
  const good = await signToken({ sub: "deleted-user", email: "d@example.invalid" });
  const [header, payload] = good.split(".");
  const res = await getMe(bearer(`${header}.${payload}.${"x".repeat(43)}`));
  assert.equal((await res.json()).code, "NO_SESSION");
});
