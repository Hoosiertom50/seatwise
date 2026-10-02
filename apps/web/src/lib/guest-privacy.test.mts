// TS-154: unit tests for who sees guests' private notes. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guestForViewer, canSeeGuestNotes } from "./guest-privacy";

const guest = { id: "g1", firstName: "Ada", notes: "Nut allergy", rsvpNotes: "Wheelchair" };

test("the owner and Edit collaborators see the notes", () => {
  assert.deepEqual(guestForViewer(guest, "OWNER"), guest);
  assert.deepEqual(guestForViewer(guest, "EDIT"), guest);
});

test("View and Comment collaborators see the guest without them", () => {
  for (const level of ["VIEW", "COMMENT", null, undefined]) {
    const seen = guestForViewer(guest, level);
    assert.equal(seen.notes, null, String(level));
    assert.equal(seen.rsvpNotes, null, String(level));
    assert.equal(seen.firstName, "Ada");
    assert.equal(canSeeGuestNotes(level), false);
  }
});
