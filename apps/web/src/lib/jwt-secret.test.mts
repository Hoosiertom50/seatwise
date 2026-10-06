// TS-179: unit tests for which JWT_SECRET values are refused. Run with
// `pnpm --filter @seatwise/web test`. A throwaway secret is set before lib/auth loads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.JWT_SECRET = randomBytes(32).toString("hex");

const { jwtSecretProblem } = await import("./auth");

const GOOD = randomBytes(32).toString("hex");

test("a long random secret is accepted in production and in development", () => {
  assert.equal(jwtSecretProblem(GOOD, "production"), null);
  assert.equal(jwtSecretProblem(GOOD, "development"), null);
});

test("a missing secret is refused everywhere", () => {
  assert.match(jwtSecretProblem(undefined, "production") ?? "", /not set/);
  assert.match(jwtSecretProblem("", "development") ?? "", /not set/);
});

test("in production, a secret shorter than 32 characters is refused", () => {
  assert.match(jwtSecretProblem("x".repeat(31), "production") ?? "", /shorter than 32/);
  assert.equal(jwtSecretProblem("x".repeat(32), "production"), null);
});

test("in production, the README and .env.example placeholders are refused", () => {
  for (const placeholder of ["replace-with-a-long-random-secret", "a long random string", "changeme", "secret", "  CHANGEME "]) {
    assert.ok(jwtSecretProblem(placeholder, "production"), `expected "${placeholder}" to be refused`);
  }
  // Long enough on length alone, but still a known placeholder.
  assert.match(jwtSecretProblem("replace-with-a-long-random-secret", "production") ?? "", /placeholder/);
});

test("local development keeps working with the README's example value", () => {
  assert.equal(jwtSecretProblem("a long random string", "development"), null);
  assert.equal(jwtSecretProblem("replace-with-a-long-random-secret", undefined), null);
});
