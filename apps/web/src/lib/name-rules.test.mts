// TS-156: unit tests for the rule that names going into emails can't read as a web address.
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeWebAddress } from "../../../../packages/shared/src/validation";
import { signupSchema } from "../../../../packages/shared/src/schemas/auth";

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
