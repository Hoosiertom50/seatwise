// TS-147: unit tests for where sign-in may send someone afterwards. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNextPath } from "./safe-next";

test("ordinary Seatwise paths are kept, with their query and hash", () => {
  assert.equal(safeNextPath("/weddings/abc"), "/weddings/abc");
  assert.equal(safeNextPath("/invites/tok?x=1#top"), "/invites/tok?x=1#top");
  assert.equal(safeNextPath("/dashboard"), "/dashboard");
});

test("nothing, or anything that isn't a path, falls back", () => {
  for (const raw of [null, undefined, "", "weddings/abc", "https://evil.example", "javascript:alert(1)"]) {
    assert.equal(safeNextPath(raw), "/dashboard", String(raw));
  }
  assert.equal(safeNextPath("https://evil.example", ""), "");
});

test("protocol-relative tricks fall back, including ones hidden with tabs, line breaks or backslashes", () => {
  for (const raw of [
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "/\t\\evil.example",
    "/ok\\..\\..\\evil",
    "/\u0000/evil.example",
    "/\u007f/evil.example",
  ]) {
    assert.equal(safeNextPath(raw), "/dashboard", JSON.stringify(raw));
  }
});

test("a decoded ?next= value with an encoded tab is refused", () => {
  const next = new URLSearchParams("next=/%09/evil.example").get("next");
  assert.equal(safeNextPath(next), "/dashboard");
});

test("dot segments that would resolve to another site fall back (TS-162)", () => {
  for (const raw of ["/.//evil.example", "/..//evil.example", "/a/..//evil.example", "/%2e%2e//evil.example", "/./%2e//evil.example/x?y=1"]) {
    assert.equal(safeNextPath(raw), "/dashboard", raw);
  }
  // Ordinary dot segments that stay on Seatwise still work.
  assert.equal(safeNextPath("/weddings/./abc"), "/weddings/abc");
  assert.equal(safeNextPath("/a/../dashboard"), "/dashboard");
});
