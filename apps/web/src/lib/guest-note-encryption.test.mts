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

// TS-149
test("a stored note whose authentication tag has been shortened doesn't decrypt", () => {
  env.NODE_ENV = "production";
  env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const stored = encryptText("Allergic to shellfish")!;
  const [prefix1, prefix2, iv, tag, data] = stored.split(":");
  const shortTag = Buffer.from(tag, "base64").subarray(0, 4).toString("base64");
  assert.equal(decryptText([prefix1, prefix2, iv, shortTag, data].join(":")), "[unable to decrypt]");
  assert.equal(decryptText(stored), "Allergic to shellfish");
});

// TS-192: a placeholder that is long enough to pass the length check is still refused.
test("production refuses the .env.example value, the dev key and other known placeholders", async () => {
  const { DEV_ONLY_ENCRYPTION_KEY, PLACEHOLDER_SECRETS } = await import("../../../../packages/shared/src/placeholder-secrets");
  env.NODE_ENV = "production";
  for (const placeholder of ["replace-with-a-long-random-secret", DEV_ONLY_ENCRYPTION_KEY, "  Replace-With-A-Long-Random-Secret ", ...PLACEHOLDER_SECRETS]) {
    env.ENCRYPTION_KEY = placeholder;
    assert.throws(() => encryptText("Vegetarian"), /placeholder/, `expected "${placeholder}" to be refused`);
  }
});

test("the placeholder check only applies in production (local dev may use the example value)", async () => {
  const { encryptionKeyProblem } = await import("../../../../packages/db/src/crypto");
  assert.equal(encryptionKeyProblem("replace-with-a-long-random-secret", "development"), null);
  assert.equal(encryptionKeyProblem(undefined, "test"), null);
  assert.match(encryptionKeyProblem("replace-with-a-long-random-secret", "production") ?? "", /placeholder/);
  assert.equal(encryptionKeyProblem(randomBytes(32).toString("hex"), "production"), null);
});
