// TS-97: unit tests for which past vendors "Add a vendor" suggests. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { VendorSuggestionDTO } from "@seatwise/shared";
import { matchVendorSuggestions, MAX_VENDOR_SUGGESTIONS } from "./vendor-suggestions";

function v(name: string): VendorSuggestionDTO {
  return { name, category: "FLORIST", categoryOther: null, contactName: null, contactEmail: null, contactPhone: null };
}
const names = (list: VendorSuggestionDTO[]) => list.map((s) => s.name);

test("nothing is suggested until something is typed", () => {
  assert.deepEqual(matchVendorSuggestions([v("Bloom & Co")], "", []), []);
  assert.deepEqual(matchVendorSuggestions([v("Bloom & Co")], "   ", []), []);
});

test("matches anywhere in the name, ignoring case and extra spaces, names starting with it first", () => {
  const all = [v("Petal Bloom"), v("Bloom & Co"), v("DJ Spin")];
  assert.deepEqual(names(matchVendorSuggestions(all, "  BLOOM ", [])), ["Bloom & Co", "Petal Bloom"]);
  assert.deepEqual(names(matchVendorSuggestions(all, "spin", [])), ["DJ Spin"]);
  assert.deepEqual(names(matchVendorSuggestions(all, "cake", [])), []);
});

test("a vendor already on this wedding isn't suggested again", () => {
  assert.deepEqual(names(matchVendorSuggestions([v("Bloom & Co"), v("Bloom Bakery")], "bloom", ["bloom & co"])), ["Bloom Bakery"]);
});

test("once the typed name is exactly a suggestion, the list closes", () => {
  assert.deepEqual(matchVendorSuggestions([v("Bloom & Co"), v("Bloom & Co Events")], "bloom & co", []), []);
});

test("at most a handful show at once", () => {
  const many = Array.from({ length: 12 }, (_, i) => v(`Florist ${i + 10}`));
  assert.equal(matchVendorSuggestions(many, "florist", []).length, MAX_VENDOR_SUGGESTIONS);
});
