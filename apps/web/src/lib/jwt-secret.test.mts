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

test("TS-192: in production, the published development encryption key is refused as a JWT secret too", async () => {
  const { DEV_ONLY_ENCRYPTION_KEY } = await import("../../../../packages/shared/src/placeholder-secrets");
  assert.match(jwtSecretProblem(DEV_ONLY_ENCRYPTION_KEY, "production") ?? "", /placeholder/);
});

// TS-204: a placeholder pasted with its quotes, as a whole .env line, with invisible characters,
// or with something added to it, is still a placeholder.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const NO_BREAK_SPACE = String.fromCharCode(0x00a0);

test("TS-204: placeholder variants are refused in production", () => {
  const variants = [
    `"replace-with-a-long-random-secret"`,
    `'replace-with-a-long-random-secret'`,
    "JWT_SECRET=replace-with-a-long-random-secret",
    `JWT_SECRET="replace-with-a-long-random-secret"`,
    `export JWT_SECRET='replace-with-a-long-random-secret'`,
    `${ZERO_WIDTH_SPACE}replace-with-a-long-random-secret${BYTE_ORDER_MARK}`,
    `replace${ZERO_WIDTH_SPACE}-with-a-long-random-secret`,
    `${NO_BREAK_SPACE}"replace-with-a-long-random-secret"${NO_BREAK_SPACE}`,
    "REPLACE_WITH_A_LONG_RANDOM_SECRET",
    "replace-with-a-long-random-secret-please-2026",
    "my-replace-with-a-long-random-secret",
    `"a long random string"`,
    "changeme-changeme-changeme-changeme-1",
    `"dev-only-encryption-key-change-in-production-9d2f7a1c"`,
  ];
  for (const v of variants) {
    assert.match(jwtSecretProblem(v, "production") ?? "", /placeholder/, `expected ${JSON.stringify(v)} to be refused as a placeholder`);
  }
});

test("TS-204: a quoted value is measured without its quotes", () => {
  assert.match(jwtSecretProblem(`"${"x".repeat(30)}"`, "production") ?? "", /shorter than 32/);
});

test("TS-204: random values are not mistaken for placeholders", () => {
  for (let i = 0; i < 200; i++) {
    assert.equal(jwtSecretProblem(randomBytes(32).toString("hex"), "production"), null);
    assert.equal(jwtSecretProblem(randomBytes(32).toString("base64"), "production"), null);
  }
});

test("TS-204: JWT_SECRET may not be the same as ENCRYPTION_KEY in production", () => {
  const other = randomBytes(32).toString("hex");
  assert.match(jwtSecretProblem(GOOD, "production", GOOD) ?? "", /same as ENCRYPTION_KEY/);
  assert.match(jwtSecretProblem(GOOD, "production", ` "${GOOD}" `) ?? "", /same as ENCRYPTION_KEY/);
  assert.equal(jwtSecretProblem(GOOD, "production", other), null);
  assert.equal(jwtSecretProblem(GOOD, "production", undefined), null);
  assert.equal(jwtSecretProblem(GOOD, "development", GOOD), null);
});

// Copilot review on PR #102: keys are case-sensitive -- an upper- and lower-case version of the same
// characters are two different keys, so they aren't refused as "the same".
test("JWT_SECRET and ENCRYPTION_KEY that differ only in letter case are different keys", () => {
  const mixed = "Ab3dEf9hIjK2mNoPqR5tUvWxYz7aBcDeFgH1jKlMnOp";
  assert.equal(jwtSecretProblem(mixed, "production", mixed.toLowerCase()), null);
  assert.match(jwtSecretProblem(mixed, "production", `'${mixed}'`) ?? "", /same as ENCRYPTION_KEY/);
});
