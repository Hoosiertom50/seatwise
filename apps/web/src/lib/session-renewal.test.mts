// TS-94: unit tests for the session-renewal policy and the token claims it depends on (.mts so the
// secret can be set before lib/auth loads, via top-level await). Run with
// `pnpm --filter @seatwise/web test` (Node's built-in test runner via tsx -- no app server or
// database needed). A throwaway secret is set before lib/auth loads, so no real JWT_SECRET is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.JWT_SECRET = randomBytes(32).toString("hex");

const { RENEW_AFTER_SECONDS, RENEWAL_LIMIT_SECONDS, shouldRenew } = await import("./session-renewal");
const { signToken, verifyToken, AUTH_TOKEN_TTL_SECONDS } = await import("./auth");

const NOW = 2_000_000_000;

test("a token younger than a day is left alone", () => {
  assert.equal(shouldRenew({ issuedAt: NOW - RENEW_AFTER_SECONDS + 1, authTime: NOW - 10 }, NOW), false);
});

test("a token a day or more old is renewed while the sign-in is recent enough", () => {
  assert.equal(shouldRenew({ issuedAt: NOW - RENEW_AFTER_SECONDS, authTime: NOW - RENEW_AFTER_SECONDS }, NOW), true);
  assert.equal(shouldRenew({ issuedAt: NOW - 20 * 86400, authTime: NOW - 60 * 86400 }, NOW), true);
});

test("renewal stops once the original sign-in reaches the absolute limit", () => {
  assert.equal(shouldRenew({ issuedAt: NOW - 2 * 86400, authTime: NOW - RENEWAL_LIMIT_SECONDS }, NOW), false);
});

test("a freshly signed token carries authTime = its own issue time, and a 30-day expiry", async () => {
  const before = Math.floor(Date.now() / 1000);
  const claims = await verifyToken(await signToken({ sub: "u1", email: "a@example.invalid" }));
  assert.ok(claims);
  assert.equal(claims.sub, "u1");
  assert.ok(claims.issuedAt >= before);
  assert.equal(claims.authTime, claims.issuedAt);
  assert.equal(AUTH_TOKEN_TTL_SECONDS, 30 * 86400);
});

test("a renewed token keeps the original sign-in time, so the absolute limit can't be reset by renewing", async () => {
  const originalAuthTime = Math.floor(Date.now() / 1000) - 45 * 86400;
  const claims = await verifyToken(await signToken({ sub: "u1", email: "a@example.invalid", authTime: originalAuthTime }));
  assert.equal(claims?.authTime, originalAuthTime);
});

test("a token signed with a different secret is rejected", async () => {
  const good = await signToken({ sub: "u1", email: "a@example.invalid" });
  const [header, payload] = good.split(".");
  assert.equal(await verifyToken(`${header}.${payload}.${"x".repeat(43)}`), null);
});
