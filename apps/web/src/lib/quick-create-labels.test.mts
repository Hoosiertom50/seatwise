// TS-239: unit tests for quick-create's table names. A table named with a huge number (past about
// 9 quadrillion) made the old numbering loop forever while holding the wedding's lock, and a
// slightly smaller one gave several new tables the same name. The naming is a plain function (no
// database needed). On the old code the 2^53-1 test fails (repeated names) and the 2^53 test never
// finishes, which stops the test run. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";

const { quickCreateLabels } = await import("@seatwise/db");

function assertUniqueAndFree(labels: string[], existing: string[]) {
  const lower = labels.map((l) => l.toLowerCase());
  assert.equal(new Set(lower).size, labels.length, `labels repeat: ${labels.join(", ")}`);
  const taken = new Set(existing.map((l) => l.trim().toLowerCase()));
  for (const l of lower) assert.ok(!taken.has(l), `"${l}" is already a table`);
}

test("TS-239: a table numbered past 2^53 doesn't make quick-create loop forever", () => {
  const existing = ["Table 9007199254740992", "Table 1"];
  const labels = quickCreateLabels(existing, "Table", 3);
  assert.deepEqual(labels, ["Table 2", "Table 3", "Table 4"]);
  assertUniqueAndFree(labels, existing);
});

test("TS-239: 2^53-1 doesn't give several new tables the same name", () => {
  const existing = ["Table 9007199254740991"];
  const labels = quickCreateLabels(existing, "Table", 3);
  assert.equal(labels.length, 3);
  assertUniqueAndFree(labels, existing);
});

test("TS-239: a 90-digit table number is ignored", () => {
  const existing = [`Table ${"9".repeat(90)}`];
  const labels = quickCreateLabels(existing, "Table", 100);
  assert.equal(labels[0], "Table 1");
  assert.equal(labels.length, 100);
  assertUniqueAndFree(labels, existing);
});

test("TS-239: numbers up to 9 digits still continue the sequence", () => {
  assert.deepEqual(quickCreateLabels(["Table 999999998"], "Table", 2), ["Table 999999999", "Table 1000000000"]);
  assert.deepEqual(quickCreateLabels(["Table 007"], "Table", 1), ["Table 8"]);
});

test("TS-153 still holds: numbering continues after the highest, skipping taken labels (any case)", () => {
  const existing = ["Table 1", "Table 3", "table 4", "Head Table", "Table 5 "];
  // Highest is 5, so the new ones start at 6.
  assert.deepEqual(quickCreateLabels(existing, "Table", 2), ["Table 6", "Table 7"]);
  // A different prefix starts at 1 but skips a label already used.
  assert.deepEqual(quickCreateLabels(["VIP 1x", "vip 1"], " VIP ", 2), ["VIP 2", "VIP 3"]);
});

test("TS-239: a prefix with regex characters is matched literally", () => {
  assert.deepEqual(quickCreateLabels(["T.1 9", "Tx1 50"], "T.1", 1), ["T.1 10"]);
});
