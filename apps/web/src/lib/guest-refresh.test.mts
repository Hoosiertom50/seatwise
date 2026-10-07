// TS-207: unit tests for merging a re-fetched guest list into the one on screen. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRefreshedGuests, guestIdFromFieldId, crossesGuestPrivacyLine, guestsAfterAccessChange } from "./guest-refresh";
import { compareGuestNames } from "./guest-name-order";

type G = { id: string; revision: number; name: string };
const g = (id: string, revision: number, name = id): G => ({ id, revision, name });
const ids = (list: G[]) => new Set(list.map((x) => x.id));

test("a newer copy from the server replaces the one on screen", () => {
  const current = [g("a", 1, "Ann"), g("b", 1)];
  const merged = mergeRefreshedGuests(current, [g("a", 2, "Ann (RSVP'd)"), g("b", 1)], { idsAtFetchStart: ids(current) });
  assert.equal(merged[0].name, "Ann (RSVP'd)");
  assert.equal(merged[1], current[1]);
});

test("an older or equal copy never replaces a save made here while the fetch was out", () => {
  const current = [g("a", 5, "saved here")];
  const merged = mergeRefreshedGuests(current, [g("a", 4, "old")], { idsAtFetchStart: ids(current) });
  assert.equal(merged, current);
  assert.equal(mergeRefreshedGuests(current, [g("a", 5, "same")], { idsAtFetchStart: ids(current) }), current);
});

test("nothing new gives back the same array (no re-render)", () => {
  const current = [g("a", 1), g("b", 2)];
  assert.equal(mergeRefreshedGuests(current, [g("a", 1), g("b", 2)], { idsAtFetchStart: ids(current) }), current);
});

test("a guest added elsewhere (a walk-in on another phone) is added", () => {
  const current = [g("a", 1)];
  const merged = mergeRefreshedGuests(current, [g("a", 1), g("zed", 0, "Zed")], { idsAtFetchStart: ids(current) });
  assert.deepEqual(merged.map((x) => x.id), ["a", "zed"]);
});

test("new guests are placed with the compare function when one is given", () => {
  const current = [g("b", 1, "Bo"), g("d", 1, "Di")];
  const merged = mergeRefreshedGuests(current, [g("b", 1, "Bo"), g("c", 0, "Cy"), g("d", 1, "Di")], {
    idsAtFetchStart: ids(current),
    compare: (x, y) => x.name.localeCompare(y.name),
  });
  assert.deepEqual(merged.map((x) => x.name), ["Bo", "Cy", "Di"]);
});

test("a guest deleted elsewhere is taken off", () => {
  const current = [g("a", 1), g("gone", 3)];
  const merged = mergeRefreshedGuests(current, [g("a", 1)], { idsAtFetchStart: ids(current) });
  assert.deepEqual(merged.map((x) => x.id), ["a"]);
});

test("a guest added here while the fetch was out is kept", () => {
  const atStart = new Set(["a"]);
  const current = [g("a", 1), g("new-here", 0)];
  const merged = mergeRefreshedGuests(current, [g("a", 1)], { idsAtFetchStart: atStart });
  assert.equal(merged, current);
});

test("a guest deleted here while the fetch was out isn't put back", () => {
  const atStart = new Set(["a", "deleted-here"]);
  const current = [g("a", 1)];
  const merged = mergeRefreshedGuests(current, [g("a", 1), g("deleted-here", 1)], { idsAtFetchStart: atStart });
  assert.equal(merged, current);
});

test("a protected row (being typed in) is never changed or removed", () => {
  const current = [g("a", 1, "typing"), g("b", 1)];
  const protectedIds = new Set(["a"]);
  assert.equal(mergeRefreshedGuests(current, [g("a", 9, "theirs"), g("b", 1)], { idsAtFetchStart: ids(current), protectedIds }), current);
  assert.equal(mergeRefreshedGuests(current, [g("b", 1)], { idsAtFetchStart: ids(current), protectedIds }), current);
});

test("the guest a Guests-tab box belongs to is read from its id", () => {
  assert.equal(guestIdFromFieldId("guest-abc123-firstName"), "abc123");
  assert.equal(guestIdFromFieldId("guest-5f1c2b9e-0d1a-4c4e-9a7b-1b2c3d4e5f60-email"), "5f1c2b9e-0d1a-4c4e-9a7b-1b2c3d4e5f60");
  assert.equal(guestIdFromFieldId("dayof-guest-search"), null);
  assert.equal(guestIdFromFieldId(""), null);
  assert.equal(guestIdFromFieldId(null), null);
});

// TS-216: a merge that changed anything sorts the list again, not only one that added a guest.
test("a guest renamed elsewhere moves to their new place in the list", () => {
  type N = { id: string; revision: number; firstName: string; lastName: string };
  const n = (id: string, revision: number, firstName: string, lastName: string): N => ({ id, revision, firstName, lastName });
  const idsOf = (list: N[]) => new Set(list.map((x) => x.id));
  const current = [n("1", 1, "Bo", "Brown"), n("2", 1, "Zed", "Smith")];
  const merged = mergeRefreshedGuests(current, [n("1", 1, "Bo", "Brown"), n("2", 2, "Amy", "Adams")], {
    idsAtFetchStart: idsOf(current),
    compare: compareGuestNames,
  });
  assert.deepEqual(merged.map((x) => `${x.firstName} ${x.lastName}`), ["Amy Adams", "Bo Brown"]);
  // Nothing changed: the same array back, as it was.
  const unsorted = [n("2", 1, "Zed", "Smith"), n("1", 1, "Bo", "Brown")];
  assert.equal(mergeRefreshedGuests(unsorted, [...unsorted], { idsAtFetchStart: idsOf(unsorted), compare: compareGuestNames }), unsorted);
});

// TS-217: an access change doesn't change a guest's revision, so merging alone keeps the copy loaded
// at the old access level -- the page replaces the list instead.
type P = { id: string; revision: number; notes: string | null; rsvpNotes: string | null; email: string | null };
const p = (id: string, notes: string | null, email: string | null, rsvpNotes: string | null = null): P => ({
  id,
  revision: 3,
  notes,
  rsvpNotes,
  email,
});

test("merging alone would keep the View copy after a raise to Edit (why the list is replaced)", () => {
  const redacted = [p("ann", null, null)];
  const full = [p("ann", "Severe nut allergy", "ann@example.com")];
  assert.equal(mergeRefreshedGuests(redacted, full, { idsAtFetchStart: new Set(["ann"]) }), redacted);
});

test("crossing the private-data line is View/Comment <-> Edit/Owner, either way", () => {
  assert.equal(crossesGuestPrivacyLine("VIEW", "EDIT"), true);
  assert.equal(crossesGuestPrivacyLine("COMMENT", "OWNER"), true);
  assert.equal(crossesGuestPrivacyLine("EDIT", "VIEW"), true);
  assert.equal(crossesGuestPrivacyLine("OWNER", "COMMENT"), true);
  assert.equal(crossesGuestPrivacyLine("VIEW", "COMMENT"), false);
  assert.equal(crossesGuestPrivacyLine("EDIT", "OWNER"), false);
  assert.equal(crossesGuestPrivacyLine(null, "EDIT"), false);
});

test("lowered below Edit, private notes, RSVP notes and emails go at once", () => {
  const current = [p("ann", "Severe nut allergy", "ann@example.com", "Can't wait")];
  const shown = guestsAfterAccessChange(current, "VIEW");
  assert.deepEqual(shown[0], { id: "ann", revision: 3, notes: null, rsvpNotes: null, email: null });
  assert.equal(current[0].notes, "Severe nut allergy", "the list on screen isn't changed in place");
  assert.equal(guestsAfterAccessChange(current, "COMMENT")[0].email, null);
});

test("raised to Edit, the list is left for the fresh one to replace", () => {
  const current = [p("ann", null, null)];
  assert.equal(guestsAfterAccessChange(current, "EDIT"), current);
  assert.equal(guestsAfterAccessChange(current, "OWNER"), current);
});
