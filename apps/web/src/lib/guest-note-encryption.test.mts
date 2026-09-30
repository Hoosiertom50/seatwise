// TS-127: unit tests for the at-rest encryption of guest notes (packages/db/src/crypto.ts) --
// specifically that production never falls back to the published dev key. Run with
// `pnpm --filter @seatwise/web test` (no app server or database needed).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptText, encryptText } from "../../../../packages/db/src/crypto";

const env = process.env as Record<string, string | undefined>;
const original = { NODE_ENV: env.NODE_ENV, ENCRYPTION_KEY: env.ENCRYPTION_KEY };
afterEach(() => {
  env.NODE_ENV = original.NODE_ENV;
  env.ENCRYPTION_KEY = original.ENCRYPTION_KEY;
});

test("production without ENCRYPTION_KEY refuses to encrypt or decrypt", () => {
  env.NODE_ENV = "development";
  delete env.ENCRYPTION_KEY;
  const storedWithDevKey = encryptText("Vegetarian")!;

  env.NODE_ENV = "production";
  assert.throws(() => encryptText("Vegetarian"), /ENCRYPTION_KEY is not set/);
  assert.throws(() => decryptText(storedWithDevKey), /ENCRYPTION_KEY is not set/);
});

test("production refuses a key shorter than 32 characters", () => {
  env.NODE_ENV = "production";
  env.ENCRYPTION_KEY = "too-short";
  assert.throws(() => encryptText("Vegetarian"), /too short/);
});

test("production with a real key round-trips, and the stored text isn't the note", () => {
  env.NODE_ENV = "production";
  env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const stored = encryptText("Nut allergy")!;
  assert.ok(stored.startsWith("enc:v1:"));
  assert.ok(!stored.includes("Nut allergy"));
  assert.equal(decryptText(stored), "Nut allergy");
});

test("a note encrypted with one key can't be read with another", () => {
  env.NODE_ENV = "production";
  env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const stored = encryptText("Wheelchair access")!;
  env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
  assert.equal(decryptText(stored), "[unable to decrypt]");
});

test("outside production, a missing key still uses the dev fallback (local dev and e2e)", () => {
  env.NODE_ENV = "development";
  delete env.ENCRYPTION_KEY;
  assert.equal(decryptText(encryptText("Gluten free")), "Gluten free");
});

test("empty and legacy plain-text notes pass through untouched", () => {
  env.NODE_ENV = "production";
  env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
  assert.equal(encryptText(null), null);
  assert.equal(decryptText(null), null);
  assert.equal(decryptText("written before encryption existed"), "written before encryption existed");
});
