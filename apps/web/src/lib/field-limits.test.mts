// TS-193: unit tests for the shared typing limits (packages/shared/src/field-limits.ts) and the
// vendor contact phone rule. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTACT_PHONE_HTML_PATTERN,
  CONTACT_PHONE_MESSAGE,
  CONTACT_PHONE_PATTERN,
  FIELD_LIMITS,
  isAllowedContactPhone,
} from "../../../../packages/shared/src/field-limits";
import { createVendorSchema, updateVendorSchema } from "../../../../packages/shared/src/schemas/vendor";
import { createGuestSchema } from "../../../../packages/shared/src/schemas/guest";
import { signupSchema, loginSchema, forgotPasswordSchema } from "../../../../packages/shared/src/schemas/auth";
import { createCommentSchema } from "../../../../packages/shared/src/schemas/collaboration";
import { createTimelineEntrySchema } from "../../../../packages/shared/src/schemas/timeline";

const GOOD_PHONES = ["", "555-0199", "(317) 555-0199", "+1 317.555.0199", "317 555 0199 ext. 12", "317-555-0199 ext 4", "317-555-0199x4", "555 0199 X 22", "+44 (0)20 7946 0958"];
const BAD_PHONES = ["call Jane", "555-0199 or 555-0100", "555#0199", "ext. 12 555", "x", "555-0199 ext", "555_0199", "555/0199", "１２３"];

test("vendor contact phone: digits, spaces, + - ( ) . and an extension are accepted", () => {
  for (const phone of GOOD_PHONES) {
    assert.ok(isAllowedContactPhone(phone), phone);
    const parsed = createVendorSchema.safeParse({ name: "Florist", category: "FLORIST", contactPhone: phone });
    assert.ok(parsed.success, `${phone}: ${JSON.stringify(parsed.error?.issues)}`);
  }
});

test("vendor contact phone: anything else is refused with a clear message", () => {
  for (const phone of BAD_PHONES) {
    assert.equal(isAllowedContactPhone(phone), false, phone);
    const parsed = updateVendorSchema.safeParse({ contactPhone: phone, expectedRevision: 0 });
    assert.equal(parsed.success, false, phone);
    assert.deepEqual(parsed.error?.flatten().fieldErrors.contactPhone, [CONTACT_PHONE_MESSAGE], phone);
  }
  assert.equal(CONTACT_PHONE_MESSAGE, "Use digits and + - ( ) . only (ext. allowed)");
});

test("vendor contact phone: blank and null still clear it; surrounding spaces are trimmed first", () => {
  assert.ok(updateVendorSchema.safeParse({ contactPhone: null, expectedRevision: 0 }).success);
  assert.equal(updateVendorSchema.parse({ contactPhone: "  555-0199  ", expectedRevision: 0 }).contactPhone, "555-0199");
});

test("the phone box's HTML pattern agrees with the server's rule", () => {
  // Browsers compile `pattern` as ^(?:pattern)$ with the v flag.
  const html = new RegExp(`^(?:${CONTACT_PHONE_HTML_PATTERN})$`, "v");
  for (const phone of [...GOOD_PHONES, ...BAD_PHONES]) {
    assert.equal(html.test(phone), CONTACT_PHONE_PATTERN.test(phone), phone);
  }
});

test("the schemas use the shared limits: exactly the limit is accepted, one more is refused", () => {
  const name = { firstName: "Ana", lastName: "Lee" };
  assert.ok(createGuestSchema.safeParse({ ...name, notes: "a".repeat(FIELD_LIMITS.guestNotes) }).success);
  assert.equal(createGuestSchema.safeParse({ ...name, notes: "a".repeat(FIELD_LIMITS.guestNotes + 1) }).success, false);
  assert.ok(createGuestSchema.safeParse({ ...name, firstName: "A".repeat(FIELD_LIMITS.personName) }).success);
  assert.equal(createGuestSchema.safeParse({ ...name, firstName: "A".repeat(FIELD_LIMITS.personName + 1) }).success, false);

  assert.ok(createCommentSchema.safeParse({ targetType: "GUEST", guestId: "g1", body: "a".repeat(FIELD_LIMITS.comment) }).success);
  assert.equal(createCommentSchema.safeParse({ targetType: "GUEST", guestId: "g1", body: "a".repeat(FIELD_LIMITS.comment + 1) }).success, false);

  assert.ok(createTimelineEntrySchema.safeParse({ time: "16:30", description: "a".repeat(FIELD_LIMITS.timelineDescription) }).success);
  assert.equal(createTimelineEntrySchema.safeParse({ time: "16:30", description: "a".repeat(FIELD_LIMITS.timelineDescription + 1) }).success, false);

  const vendor = { name: "Florist", category: "FLORIST" };
  assert.equal(createVendorSchema.safeParse({ ...vendor, contactPhone: "5".repeat(FIELD_LIMITS.vendorContactPhone + 1) }).success, false);
});

test("every email field takes up to 254 characters, the longest an address can be", () => {
  assert.equal(FIELD_LIMITS.email, 254);
  const longest = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
  assert.equal(longest.length, 254);
  const tooLong = `x${longest}`;
  const password = "correct-horse-battery";
  assert.ok(signupSchema.safeParse({ name: "Ana Lee", email: longest, password }).success);
  assert.equal(signupSchema.safeParse({ name: "Ana Lee", email: tooLong, password }).success, false);
  assert.equal(loginSchema.safeParse({ email: tooLong, password }).success, false);
  assert.equal(forgotPasswordSchema.safeParse({ email: tooLong }).success, false);
  assert.equal(createGuestSchema.safeParse({ firstName: "Ana", lastName: "Lee", email: tooLong }).success, false);
  assert.equal(createVendorSchema.safeParse({ name: "Florist", category: "FLORIST", contactEmail: tooLong }).success, false);
});

test("password boxes stop at 72 characters, the most a new password can be", () => {
  assert.equal(FIELD_LIMITS.password, 72);
  assert.ok(signupSchema.safeParse({ name: "Ana Lee", email: "ana@example.com", password: "p".repeat(72) }).success);
  assert.equal(signupSchema.safeParse({ name: "Ana Lee", email: "ana@example.com", password: "p".repeat(73) }).success, false);
});
