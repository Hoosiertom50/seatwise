// TS-156: unit tests for the rule that names going into emails can't read as a web address.
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeWebAddress } from "../../../../packages/shared/src/validation";
import { signupSchema, resetPasswordSchema } from "../../../../packages/shared/src/schemas/auth";
import { createGuestSchema } from "../../../../packages/shared/src/schemas/guest";
import { createWeddingSchema, updateWeddingSchema } from "../../../../packages/shared/src/schemas/wedding";
import { duplicateWeddingSchema } from "../../../../packages/shared/src/schemas/template";

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

// TS-171: a wedding's name can't carry a phone number.
test("wedding names with 7 or more digits in a row (ignoring spaces, hyphens and periods) are refused", () => {
  const name = (v: string) => updateWeddingSchema.safeParse({ name: v });
  for (const v of [
    "Your account is suspended. Call 1 800 555 0199 now!",
    "Call 800-555-0199",
    "Ring 1.800.555.0199",
    "Ana 1234567",
    "Bo ١٢٣٤٥٦٧",
  ]) {
    const result = name(v);
    assert.equal(result.success, false, v);
    assert.match(JSON.stringify(result.error?.flatten().fieldErrors), /phone number/, v);
  }
  for (const v of ["Ana & Bo 2026", "Smith-Jones Wedding, Est. 2026", "Party of 12, 10-5-26", "Room 101 & 102"]) {
    assert.equal(name(v).success, true, v);
  }
  // The same rule wherever a wedding is named.
  assert.equal(createWeddingSchema.safeParse({ name: "Call 555 0199 12" }).success, false);
  assert.equal(duplicateWeddingSchema.safeParse({ name: "Call 555 0199 12" }).success, false);
});

test("emails only use names that pass today's rules, otherwise something neutral", async () => {
  const { emailSafePersonName, emailSafeWeddingName } = await import("./email-safe-names");
  assert.equal(emailSafePersonName(" Ana "), "Ana");
  assert.equal(emailSafePersonName("visit evilsite.com"), null);
  assert.equal(emailSafePersonName("<b>x</b>"), null);
  assert.equal(emailSafeWeddingName("Ana & Bo's Wedding"), "Ana & Bo's Wedding");
  assert.equal(emailSafeWeddingName("Free gift at evilsite.com"), null);
  // TS-171: a name saved before the phone-number rule isn't put into an email either.
  assert.equal(emailSafeWeddingName("Call 1 800 555 0199 now!"), null);
});
