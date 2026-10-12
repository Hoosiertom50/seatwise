// TS-174: unit tests for the shared bounds on revisions and dates -- a value the database can't
// store is a 422, never a server error. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_REVISION } from "../../../../packages/shared/src/schemas/common";
import { setBudgetSchema, updateVendorSchema } from "../../../../packages/shared/src/schemas/vendor";
import { updateGuestSchema } from "../../../../packages/shared/src/schemas/guest";
import { updateTimelineEntrySchema } from "../../../../packages/shared/src/schemas/timeline";
import { guestImportRequestSchema } from "../../../../packages/shared/src/schemas/guest-import";
import { updateWeddingSchema } from "../../../../packages/shared/src/schemas/wedding";

test("expectedRevision accepts the largest int4 and refuses one more, everywhere it's taken", () => {
  for (const schema of [updateGuestSchema, updateVendorSchema, updateTimelineEntrySchema]) {
    assert.equal(schema.safeParse({ expectedRevision: MAX_REVISION }).success, true);
    assert.equal(schema.safeParse({ expectedRevision: MAX_REVISION + 1 }).success, false);
  }
  assert.equal(setBudgetSchema.safeParse({ budgetCents: 100, expectedRevision: MAX_REVISION }).success, true);
  assert.equal(setBudgetSchema.safeParse({ budgetCents: 100, expectedRevision: 99_999_999_999 }).success, false);
  const importBody = (revision: number) => ({
    csv: "firstName,lastName\nA,B\n",
    mapping: { firstName: "firstName", lastName: "lastName" },
    expectedRevisions: { someGuest: revision },
  });
  assert.equal(guestImportRequestSchema.safeParse(importBody(MAX_REVISION)).success, true);
  assert.equal(guestImportRequestSchema.safeParse(importBody(MAX_REVISION + 1)).success, false);
});

test("wedding dates must fall between 1900 and 2200", () => {
  assert.equal(updateWeddingSchema.safeParse({ expectedRevision: 0, eventDate: "2027-06-15" }).success, true);
  assert.equal(updateWeddingSchema.safeParse({ expectedRevision: 0, eventDate: "1900-01-01" }).success, true);
  assert.equal(updateWeddingSchema.safeParse({ expectedRevision: 0, eventDate: "2200-12-31" }).success, true);
  assert.equal(updateWeddingSchema.safeParse({ expectedRevision: 0, eventDate: null }).success, true);
  assert.equal(updateWeddingSchema.safeParse({ expectedRevision: 0, eventDate: "0000-01-01" }).success, false);
  assert.equal(updateWeddingSchema.safeParse({ expectedRevision: 0, eventDate: "1899-12-31" }).success, false);
  assert.equal(updateWeddingSchema.safeParse({ expectedRevision: 0, rsvpCutoffDate: "2201-01-01" }).success, false);
  assert.equal(updateWeddingSchema.safeParse({ expectedRevision: 0, rsvpCutoffDate: "9999-12-31" }).success, false);
});
