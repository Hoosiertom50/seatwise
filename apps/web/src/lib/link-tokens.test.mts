// TS-160: unit tests for how link tokens are stored. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  hashLinkToken,
  isPlainStoredLinkToken,
  newLinkToken,
  readStoredLinkToken,
} from "../../../../packages/db/src/link-tokens";

test("a link is looked up by the SHA-256 hash of its token", () => {
  const token = "ab".repeat(32);
  assert.equal(hashLinkToken(token), createHash("sha256").update(token).digest("hex"));
});

test("a new link's stored copy is encrypted and reads back as the token", () => {
  const { token, hash, encrypted } = newLinkToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashLinkToken(token));
  assert.ok(encrypted.startsWith("enc:v1:"));
  assert.ok(!encrypted.includes(token));
  assert.equal(isPlainStoredLinkToken(encrypted), false);
  assert.equal(readStoredLinkToken(encrypted), token);
});

test("every new link is different", () => {
  assert.notEqual(newLinkToken().token, newLinkToken().token);
});

test("a copy stored before TS-160 is recognised as plain text and still reads back", () => {
  const old = "cd".repeat(32);
  assert.equal(isPlainStoredLinkToken(old), true);
  assert.equal(readStoredLinkToken(old), old);
  assert.equal(readStoredLinkToken(null), null);
});
