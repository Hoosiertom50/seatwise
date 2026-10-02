// TS-144: unit tests for how a wedding's rows are changed when copied to another database
// (packages/db/src/wedding-copy.ts). Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformRowForCopy, WEDDING_COPY_TABLES } from "../../../../packages/db/src/wedding-copy";
import { encryptTextWithSecret, decryptTextWithSecret } from "../../../../packages/db/src/crypto";

const SOURCE = "source-secret-for-tests-0123456789abcdef";
const TARGET = "target-secret-for-tests-fedcba9876543210";
const options = { sourceOwnerId: "local-tom", targetOwnerId: "live-tom", sourceSecret: SOURCE, targetSecret: TARGET };

test("the wedding moves to the target owner", () => {
  const out = transformRowForCopy("weddings", { id: "w1", ownerId: "local-tom", name: "Jim and Melissa" }, options);
  assert.equal(out.ownerId, "live-tom");
  assert.equal(out.name, "Jim and Melissa");
});

test("guest notes are re-encrypted for the target key, and the RSVP link is cleared", () => {
  const row = {
    id: "g1",
    notes: encryptTextWithSecret("Nut allergy", SOURCE),
    rsvpNotes: encryptTextWithSecret("Bringing a high chair", SOURCE),
    rsvpToken: "a".repeat(64),
  };
  const out = transformRowForCopy("guests", row, options);
  assert.equal(decryptTextWithSecret(out.notes as string, TARGET), "Nut allergy");
  assert.equal(decryptTextWithSecret(out.rsvpNotes as string, TARGET), "Bringing a high chair");
  assert.equal(decryptTextWithSecret(out.notes as string, SOURCE), "[unable to decrypt]");
  assert.equal(out.rsvpToken, null);
  assert.equal(row.rsvpToken, "a".repeat(64), "the source row is never changed");
});

test("empty notes stay empty", () => {
  const out = transformRowForCopy("guests", { id: "g2", notes: null, rsvpNotes: null, rsvpToken: null }, options);
  assert.equal(out.notes, null);
  assert.equal(out.rsvpNotes, null);
});

test("comments and history by the owner map to the new owner; anyone else becomes Former member", () => {
  const mine = transformRowForCopy("comments", { id: "c1", authorUserId: "local-tom", resolvedByUserId: "local-tom" }, options);
  assert.equal(mine.authorUserId, "live-tom");
  assert.equal(mine.resolvedByUserId, "live-tom");
  const theirs = transformRowForCopy("comments", { id: "c2", authorUserId: "someone-else", resolvedByUserId: null }, options);
  assert.equal(theirs.authorUserId, null);
  assert.equal(transformRowForCopy("change_history_entries", { id: "h1", actorUserId: "someone-else" }, options).actorUserId, null);
});

test("vendor share links are cleared", () => {
  assert.equal(transformRowForCopy("vendors", { id: "v1", shareToken: "b".repeat(64) }, options).shareToken, null);
});

test("tables are copied parent-first", () => {
  const order = WEDDING_COPY_TABLES.map((t) => t.table);
  for (const [child, parent] of [
    ["guests", "weddings"],
    ["seat_assignments", "plan_versions"],
    ["seat_assignments", "guests"],
    ["seat_assignments", "seating_tables"],
    ["restricted_table_guests", "seating_tables"],
    ["comments", "timeline_entries"],
    ["comments", "guests"],
  ]) {
    assert.ok(order.indexOf(parent) < order.indexOf(child), `${parent} before ${child}`);
  }
});
