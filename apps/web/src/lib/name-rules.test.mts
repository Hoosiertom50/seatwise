// TS-156: unit tests for the rule that names going into emails can't read as a web address.
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeWebAddress } from "../../../../packages/shared/src/validation";
import { signupSchema, resetPasswordSchema } from "../../../../packages/shared/src/schemas/auth";
import { createGuestSchema } from "../../../../packages/shared/src/schemas/guest";

test("domain-looking text is caught", () => {
  for (const v of ["evil.com", "Verify at evil.example", "seatwise.support now", "WWW.EVIL.CO", "go to bit.ly"]) {
    assert.equal(looksLikeWebAddress(v), true, v);
  }
});

test("real names and wedding titles with initials or abbreviations pass", () => {
  for (const v of ["J.R. Smith", "St. Clair", "Mary-Kate O'Neil Jr.", "Smith-Jones Wedding, Est. 2026", "A. B. Chen", "José Álvarez"]) {
    assert.equal(looksLikeWebAddress(v), false, v);
  }
});

test("signup refuses web-address names, line breaks and symbols, and trims", () => {
  const base = { email: "a@example.invalid", password: "long-enough-pw" };
  assert.equal(signupSchema.safeParse({ ...base, name: "Verify at evil.example" }).success, false);
  assert.equal(signupSchema.safeParse({ ...base, name: "Tom\nClick here" }).success, false);
  assert.equal(signupSchema.safeParse({ ...base, name: "https://x" }).success, false);
  const ok = signupSchema.safeParse({ ...base, name: "  Tom Carter  " });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.name, "Tom Carter");
});

// TS-163: a guest's name goes into their RSVP email too.
test("a guest's first or last name can't read as a web address", () => {
  const base = { firstName: "Ana", lastName: "Ruiz" };
  assert.equal(createGuestSchema.safeParse(base).success, true);
  assert.equal(createGuestSchema.safeParse({ ...base, firstName: "Claim your prize at evilsite.com" }).success, false);
  assert.equal(createGuestSchema.safeParse({ ...base, lastName: "www.example.org" }).success, false);
  assert.equal(createGuestSchema.safeParse({ ...base, firstName: "J. R." }).success, true);
});

// TS-163: bcrypt only reads a password's first 72 bytes.
test("new passwords are capped at 72 bytes, counting multi-byte letters", () => {
  const signup = (password: string) => signupSchema.safeParse({ name: "Ana Ruiz", email: "ana@example.invalid", password }).success;
  assert.equal(signup("a".repeat(72)), true);
  assert.equal(signup("a".repeat(73)), false);
  assert.equal(signup("é".repeat(36)), true); // 72 bytes
  assert.equal(signup("é".repeat(37)), false); // 74 bytes
  assert.equal(resetPasswordSchema.safeParse({ token: "a".repeat(64), password: "b".repeat(73) }).success, false);
});

test("emails only use names that pass today's rules, otherwise something neutral", async () => {
  const { emailSafePersonName, emailSafeWeddingName } = await import("./email-safe-names");
  assert.equal(emailSafePersonName(" Ana "), "Ana");
  assert.equal(emailSafePersonName("visit evilsite.com"), null);
  assert.equal(emailSafePersonName("<b>x</b>"), null);
  assert.equal(emailSafeWeddingName("Ana & Bo's Wedding"), "Ana & Bo's Wedding");
  assert.equal(emailSafeWeddingName("Free gift at evilsite.com"), null);
});
