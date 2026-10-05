// TS-168: unit tests for what notification emails may say, and the rules for a copied wedding's
// name. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emailSafeNotificationText } from "../../../../packages/db/src/queries/notifications";
import { copiedWeddingName } from "../../../../packages/shared/src/schemas/wedding";
import { duplicateWeddingSchema as duplicateFromTemplate } from "../../../../packages/shared/src/schemas/template";
import { emailSafeWeddingName } from "../../../../packages/shared/src/email-safe-names";

test("a notification whose text could read as a web address isn't emailed as written", () => {
  assert.equal(emailSafeNotificationText("Ana Ruiz is coming."), "Ana Ruiz is coming.");
  assert.equal(
    emailSafeNotificationText("Claim at evilsite.com is coming."),
    "There's an update on your wedding — open Seatwise to see it."
  );
});

test("a copy's default name keeps to the wedding-name rules, length included", () => {
  assert.equal(copiedWeddingName("Ana & Bo's Wedding"), "Ana & Bo's Wedding - copy");
  assert.equal(emailSafeWeddingName(copiedWeddingName("Ana & Bo's Wedding")), "Ana & Bo's Wedding - copy");
  const long = copiedWeddingName("A".repeat(200));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith(" - copy"));
});

test("a name given for a copy follows the same rules as any wedding name", () => {
  assert.equal(duplicateFromTemplate.safeParse({ name: "Ana and Bo, again" }).success, true);
  assert.equal(duplicateFromTemplate.safeParse({ name: "Account locked - sign in at evil.com" }).success, false);
  assert.equal(duplicateFromTemplate.safeParse({ name: "<script>" }).success, false);
  assert.equal(duplicateFromTemplate.safeParse({}).success, true);
});
