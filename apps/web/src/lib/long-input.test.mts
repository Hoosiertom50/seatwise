// TS-200: unit tests for "long input can't slow the app" -- every field whose rules include a
// pattern or a check of its own refuses a far-too-long value quickly, with the length message, and
// the vendor phone rule takes time in step with the length (it used to take time growing with the
// square of the length). Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z, type ZodTypeAny } from "zod";
import { CONTACT_PHONE_PATTERN, FIELD_LIMITS, isAllowedContactPhone } from "../../../../packages/shared/src/field-limits";
import { signupSchema, loginSchema, forgotPasswordSchema, MAX_PASSWORD_INPUT } from "../../../../packages/shared/src/schemas/auth";
import { createGuestSchema, updateGuestSchema } from "../../../../packages/shared/src/schemas/guest";
import { createWeddingSchema, updateWeddingSchema } from "../../../../packages/shared/src/schemas/wedding";
import { createVendorSchema } from "../../../../packages/shared/src/schemas/vendor";
import { lengthFirst } from "../../../../packages/shared/src/schemas/common";

const LONG = 100_000;
const FAST_MS = 50;

/** Parses `body` with `schema`, timing it; returns how long it took and the issues for `field`. */
function timedParse(schema: ZodTypeAny, body: Record<string, unknown>, field: string) {
  const started = performance.now();
  const result = schema.safeParse(body);
  const ms = performance.now() - started;
  assert.equal(result.success, false, `${field}: a ${LONG}-character value must be refused`);
  const issues = result.error!.issues.filter((i) => i.path[0] === field);
  return { ms, issues };
}

// The shapes that used to be slow: letters only (the web-address check scans on from every
// letter), "ab" repeated, and letters followed by something that isn't allowed.
const LONG_VALUES = {
  letters: "a".repeat(LONG),
  pairs: "ab".repeat(LONG / 2),
  "letters then @": "a".repeat(LONG) + "@",
  "digits and spaces": "1 ".repeat(LONG / 2) + "x",
};

const CASES: { name: string; schema: ZodTypeAny; body: (v: string) => Record<string, unknown>; field: string; max: number }[] = [
  { name: "sign-up name", schema: signupSchema, body: (v) => ({ name: v, email: "a@example.com", password: "long-enough" }), field: "name", max: FIELD_LIMITS.personName },
  { name: "guest first name", schema: createGuestSchema, body: (v) => ({ firstName: v, lastName: "Lee" }), field: "firstName", max: FIELD_LIMITS.personName },
  { name: "guest last name", schema: createGuestSchema, body: (v) => ({ firstName: "Ana", lastName: v }), field: "lastName", max: FIELD_LIMITS.personName },
  { name: "guest first name (edit)", schema: updateGuestSchema, body: (v) => ({ firstName: v }), field: "firstName", max: FIELD_LIMITS.personName },
  { name: "wedding name", schema: createWeddingSchema, body: (v) => ({ name: v }), field: "name", max: FIELD_LIMITS.weddingName },
  { name: "wedding name (rename)", schema: updateWeddingSchema, body: (v) => ({ name: v }), field: "name", max: FIELD_LIMITS.weddingName },
  { name: "vendor contact phone", schema: createVendorSchema, body: (v) => ({ name: "Florist", category: "FLORIST", contactPhone: v }), field: "contactPhone", max: FIELD_LIMITS.vendorContactPhone },
  { name: "sign-up email", schema: signupSchema, body: (v) => ({ name: "Ana", email: v, password: "long-enough" }), field: "email", max: FIELD_LIMITS.email },
  { name: "sign-in email", schema: loginSchema, body: (v) => ({ email: v, password: "x" }), field: "email", max: FIELD_LIMITS.email },
  { name: "sign-in password", schema: loginSchema, body: (v) => ({ email: "a@example.com", password: v }), field: "password", max: MAX_PASSWORD_INPUT },
  { name: "forgot-password email", schema: forgotPasswordSchema, body: (v) => ({ email: v }), field: "email", max: FIELD_LIMITS.email },
];

for (const c of CASES) {
  test(`a ${LONG}-character ${c.name} is refused in under ${FAST_MS} ms, saying it's too long`, () => {
    // Warm up once, so the first call's one-off costs (compiling patterns) aren't counted.
    c.schema.safeParse(c.body("a"));
    for (const [shape, value] of Object.entries(LONG_VALUES)) {
      const { ms, issues } = timedParse(c.schema, c.body(value), c.field);
      assert.ok(ms < FAST_MS, `${c.name} (${shape}): took ${ms.toFixed(1)} ms`);
      const tooBig = issues.find((i) => i.code === "too_big");
      assert.ok(tooBig, `${c.name} (${shape}): the length error is reported (got ${JSON.stringify(issues.map((i) => i.message))})`);
      assert.equal((tooBig as { maximum?: number }).maximum, c.max);
    }
  });
}

test("a name that's too long gets only the length message -- the other rules wait until it fits", () => {
  const { issues } = timedParse(signupSchema, { name: "1".repeat(LONG), email: "a@example.com", password: "long-enough" }, "name");
  assert.deepEqual(issues.map((i) => i.code), ["too_big"]);
});

test("names that fit still get every other rule, as before", () => {
  const name = (v: string) => signupSchema.safeParse({ name: v, email: "a@example.com", password: "long-enough" });
  assert.equal(name("  José O'Brien-Smith  ").success, true);
  assert.equal(name("  José O'Brien-Smith  ").data?.name, "José O'Brien-Smith");
  assert.equal(name("").error?.issues[0].message, "Name is required");
  assert.equal(name("   ").error?.issues[0].message, "Name is required");
  assert.match(name("evil.example").error?.issues.map((i) => i.message).join(" ") ?? "", /web address/);
  assert.match(name("Pаypal").error?.issues.map((i) => i.message).join(" ") ?? "", /different alphabets/);
  assert.equal(name("a".repeat(FIELD_LIMITS.personName)).success, true);
  assert.equal(name("a".repeat(FIELD_LIMITS.personName + 1)).success, false);
  const wedding = (v: string) => createWeddingSchema.safeParse({ name: v });
  assert.equal(wedding("Ana & Bo 2026").success, true);
  assert.match(wedding("Call 1 800 555 0199").error?.issues.map((i) => i.message).join(" ") ?? "", /phone number/);
  const phone = (v: string) => createVendorSchema.safeParse({ name: "Florist", category: "FLORIST", contactPhone: v });
  assert.equal(phone("(317) 555-0199 ext. 12").success, true);
  assert.equal(phone("call Jane").success, false);
});

test("lengthFirst trims by default (so spaces round a value don't count), and can be told not to", () => {
  let ran = 0;
  const counted = z.string().refine(() => ++ran > 0);
  assert.equal(lengthFirst(3, counted).safeParse("  abc  ").data, "abc");
  assert.equal(lengthFirst(3, counted, { trim: false }).safeParse("  abc  ").success, false);
  ran = 0;
  assert.equal(lengthFirst(3, counted).safeParse("abcd").success, false);
  assert.equal(ran, 0, "the later rules don't run on a value that's too long");
});

// --- The vendor phone pattern ---------------------------------------------------------------

/** The pattern as it was before TS-200 (kept here only to prove the new one accepts the same values). */
// The rule as TS-198 left it (trailing spaces after an extension allowed) -- the rewrite must
// accept exactly the same values.
const OLD_CONTACT_PHONE_PATTERN = /^[0-9+().\-\s]*(\s*(ext\.?|x)\s*[0-9]+)?\s*$/i;

/** A small seeded generator, so a failure can be repeated exactly. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("the new phone pattern accepts exactly the values the old one did (random values up to 40 characters)", () => {
  // Every kind of character the pattern cares about, plus some it doesn't.
  const pieces = ["0", "1", "5", "9", " ", "  ", "\t", "\n", " ", "+", "(", ")", ".", "-", "e", "E", "x", "X", "t", "T", "ext", "EXT", "ext.", "Ext. ", "x", "a", "#", "/", "_", "１"];
  const next = random(200);
  let accepted = 0;
  const runs = 200_000;
  for (let run = 0; run < runs; run++) {
    const target = Math.floor(next() * 41);
    let value = "";
    while (value.length < target) value += pieces[Math.floor(next() * pieces.length)];
    value = value.slice(0, 40);
    const before = OLD_CONTACT_PHONE_PATTERN.test(value);
    assert.equal(CONTACT_PHONE_PATTERN.test(value), before, `differs on ${JSON.stringify(value)}`);
    if (before) accepted++;
  }
  // Both answers came up plenty of times, so the comparison meant something.
  assert.ok(accepted > runs / 20 && accepted < runs - runs / 20, `accepted ${accepted} of ${runs}`);
});

test("the phone pattern checks a 100,000-character value in under 50 ms, however it's built", () => {
  const values = [
    "1" + " ".repeat(LONG) + "a",
    " ".repeat(LONG) + "x",
    "1 x" + " ".repeat(LONG) + "a",
    "ext " + "1 ".repeat(LONG / 2) + "a",
    "1".repeat(LONG),
    "x".repeat(LONG),
    "ext.".repeat(LONG / 4),
  ];
  isAllowedContactPhone("555-0199");
  for (const value of values) {
    const started = performance.now();
    isAllowedContactPhone(value);
    const ms = performance.now() - started;
    assert.ok(ms < FAST_MS, `${JSON.stringify(value.slice(0, 12))}...: took ${ms.toFixed(1)} ms`);
  }
});
