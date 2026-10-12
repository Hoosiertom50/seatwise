// TS-202: unit tests for "a party of one has no plus-ones" -- adding a guest, and every import
// row (new guests, and rows that lower a party to 1). Editing a guest is covered by the same rule in
// updateGuestForWedding and by e2e. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plusOnesForParty } from "../../../../packages/shared/src/guest-counts";
import {
  parseGuestImportRow,
  withoutPlusOnesForPartyOfOne,
} from "../../../../packages/shared/src/guest-import-row";
import type { GuestImportCurrentValues } from "../../../../packages/shared/src/guest-import-compare";

const SIDES = { sideLabel1: "Bride", sideLabel2: "Groom" };
const MAPPING = { firstName: "First", lastName: "Last", headcount: "Headcount", plusOneNames: "Plus-ones" };
const HEADERS = ["First", "Last", "Headcount", "Plus-ones"];

function current(overrides: Partial<GuestImportCurrentValues> = {}): GuestImportCurrentValues {
  return {
    firstName: "Ann",
    lastName: "Lee",
    partyName: null,
    headcount: 2,
    tier: "OTHER",
    rsvpStatus: "PENDING",
    requiresAccessibleTable: false,
    dayOfAttendance: "ATTENDING",
    side: "BOTH",
    ageCategory: "ADULT",
    notes: null,
    plusOneNames: "Sam Lee",
    ...overrides,
  };
}

test("TS-202: adding a guest -- a party of one keeps no plus-ones, a bigger party keeps them", () => {
  assert.equal(plusOnesForParty(1, "Sam Lee"), null);
  assert.equal(plusOnesForParty(2, "Sam Lee"), "Sam Lee");
  assert.equal(plusOnesForParty(3, null), null);
  assert.equal(plusOnesForParty(1, undefined), null);
});

test("TS-202: a new import row for a party of one drops its Plus-ones cell", () => {
  const one = parseGuestImportRow(["Ann", "Lee", "1", "Sam Lee"], HEADERS, MAPPING, SIDES);
  assert.deepEqual(one.errors, []);
  assert.equal(one.data.plusOneNames, null);
  // No Headcount cell means a party of one too.
  const blank = parseGuestImportRow(["Ann", "Lee", "", "Sam Lee"], HEADERS, MAPPING, SIDES);
  assert.equal(blank.data.plusOneNames, null);
  const two = parseGuestImportRow(["Ann", "Lee", "2", "Sam Lee"], HEADERS, MAPPING, SIDES);
  assert.equal(two.data.plusOneNames, "Sam Lee");
});

test("TS-202: an import row that lowers a party to 1 clears the plus-ones it had", () => {
  // The Plus-ones cell says what the guest already has (taken as it is) -- still cleared, and no
  // longer counted as kept as it was.
  const kept = parseGuestImportRow(["Ann", "Lee", "1", "Sam Lee"], HEADERS, MAPPING, SIDES, current());
  assert.equal(kept.data.plusOneNames, null);
  assert.ok(!kept.keptAsIs.includes("plusOneNames"));
  // No Plus-ones column at all: the names they had are cleared.
  const noColumn = parseGuestImportRow(["Ann", "Lee", "1"], ["First", "Last", "Headcount"], {
    firstName: "First",
    lastName: "Last",
    headcount: "Headcount",
  }, SIDES, current());
  assert.equal(noColumn.data.plusOneNames, null);
  assert.ok("plusOneNames" in noColumn.data);
});

test("TS-202: plus-ones added to a guest who is a party of one are dropped", () => {
  const row = parseGuestImportRow(
    ["Ann", "Lee", "", "Sam Lee"],
    HEADERS,
    MAPPING,
    SIDES,
    current({ headcount: 1, plusOneNames: null })
  );
  assert.equal(row.data.plusOneNames, null);
});

test("TS-202: a row that changes neither the party size nor the plus-ones leaves older names alone", () => {
  // An untouched export of a guest saved before this rule (party of 1 with names) still changes nothing.
  const legacy = current({ headcount: 1, plusOneNames: "Sam Lee" });
  const row = parseGuestImportRow(["Ann", "Lee", "1", "Sam Lee"], HEADERS, MAPPING, SIDES, legacy);
  assert.equal(row.data.plusOneNames, "Sam Lee");
  assert.deepEqual(withoutPlusOnesForPartyOfOne({}, legacy), {});
});

test("TS-202: the commit's own check (changed fields only, guest as they are now)", () => {
  const now = current({ headcount: 3, plusOneNames: "Sam, Jo" });
  // Lowered to 1: the names go.
  assert.deepEqual(withoutPlusOnesForPartyOfOne({ headcount: 1 }, now), { headcount: 1, plusOneNames: null });
  // Lowered to 2: the names stay.
  assert.deepEqual(withoutPlusOnesForPartyOfOne({ headcount: 2 }, now), { headcount: 2 });
  // A new guest (no current) of one with names.
  assert.deepEqual(withoutPlusOnesForPartyOfOne({ firstName: "Bo", plusOneNames: "Kim" }), {
    firstName: "Bo",
    plusOneNames: null,
  });
  // A CLEAR of the plus-ones is left as it is.
  assert.deepEqual(withoutPlusOnesForPartyOfOne({ headcount: 1, plusOneNames: null }, now), {
    headcount: 1,
    plusOneNames: null,
  });
});
