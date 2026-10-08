// TS-250: guests flagged "Needs reassignment" on a still-approved plan -- left off their table on
// the PDFs (listed on their own), warned about next to Export, and shown as needing a new seat on the
// Day-of tab. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsReassignmentExportWarning } from "./export-download";
import { dayOfSeatStatus, dayOfSwapTableText } from "./day-of-seat-status";

const guest = (id: string, firstName: string, lastName: string, extra: Partial<{ headcount: number; plusOneNames: string | null; dayOfAttendance: string }> = {}) => ({
  id,
  firstName,
  lastName,
  headcount: 1,
  plusOneNames: null,
  dayOfAttendance: "ATTENDING",
  ...extra,
});

test("export data: a flagged guest isn't at their table or in the alphabetical list -- they're listed on their own", async () => {
  const { arrangeExportGuests } = await import("./export-data");
  const guests = [
    guest("a", "Ann", "Lee"),
    guest("b", "Bo", "Flag", { headcount: 2, plusOneNames: "Kim" }),
    guest("c", "Cy", "New"),
    guest("d", "Di", "Able", { dayOfAttendance: "ATTENDING" }),
  ];
  const assignments = [
    { guestId: "a", guestName: "Ann Lee", tableId: "t3", tableLabel: "Table 3", needsReassignment: false },
    { guestId: "b", guestName: "Bo Flag", tableId: "t3", tableLabel: "Table 3", needsReassignment: true },
    { guestId: "d", guestName: "Di Able", tableId: "t1", tableLabel: "Table 1", needsReassignment: true },
  ];
  const tables = [
    { id: "t1", label: "Table 1" },
    { id: "t3", label: "Table 3" },
  ];
  const out = arrangeExportGuests(assignments, guests, tables);
  assert.deepEqual(out.sortedRows.map((r) => r.guestName), ["Ann Lee"]);
  assert.deepEqual(out.tables, [
    { label: "Table 1", guestNames: [] },
    { label: "Table 3", guestNames: ["Ann Lee"] },
  ]);
  // Sorted by last name like every other list; each with the table they're at now, and the flag.
  assert.deepEqual(out.needsReassignment, [
    { guestName: "Di Able", tableLabel: "Table 1", plusOneNames: null, needsReassignment: true },
    { guestName: "Bo Flag", tableLabel: "Table 3", plusOneNames: "Kim", needsReassignment: true },
  ]);
  // A flagged guest still has a seat -- they're not "Not seated" as well.
  assert.deepEqual(out.unseated.map((u) => u.guestName), ["Cy New"]);
});

test("pdf: splitFlagged keeps flagged rows off the table whichever way they're passed", async () => {
  const { splitFlagged } = await import("./pdf");
  const ann = { guestName: "Ann Lee", tableLabel: "Table 3" };
  const bo = { guestName: "Bo Flag", tableLabel: "Table 3", needsReassignment: true };
  const di = { guestName: "Di Able", tableLabel: "Table 1", needsReassignment: true };
  assert.deepEqual(splitFlagged([ann, bo], { needsReassignment: [di] }), { rows: [ann], flagged: [di, bo] });
  assert.deepEqual(splitFlagged([ann], {}), { rows: [ann], flagged: [] });
});

test("the export warning says how many guests need a new seat, in plain words", () => {
  assert.equal(needsReassignmentExportWarning(0), null);
  assert.match(needsReassignmentExportWarning(1)!, /^1 guest needs a new seat .*"Needs reassignment".*no place card/);
  assert.match(needsReassignmentExportWarning(2)!, /^2 guests need a new seat /);
});

test("Day-of: a flagged guest reads 'Needs reassignment (at {table})', not 'Seated at {table}'", () => {
  assert.equal(dayOfSeatStatus(false, { tableLabel: "Table 3", needsReassignment: true }), "Needs reassignment (at Table 3)");
  assert.equal(dayOfSeatStatus(false, { tableLabel: "Table 3", needsReassignment: false }), "Seated at Table 3");
  assert.equal(dayOfSeatStatus(false, undefined), "Unassigned");
  assert.equal(dayOfSeatStatus(true, { tableLabel: "Table 3", needsReassignment: true }), "Not attending");
  assert.equal(dayOfSwapTableText({ tableLabel: "Table 3", needsReassignment: true }), "Table 3, needs a new seat");
  assert.equal(dayOfSwapTableText({ tableLabel: "Table 3", needsReassignment: false }), "Table 3");
});
