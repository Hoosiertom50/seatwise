// TS-179: unit tests for the "this body isn't JSON" rule shared by proxy.ts and readJson(). Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { declaresBodyTooLarge, isNonJsonBody, MAX_JSON_BODY_BYTES, readBodyTextWithin } from "./json-body";

const h = (init: Record<string, string>) => new Headers(init);

test("a JSON body is accepted, with or without a charset", () => {
  assert.equal(isNonJsonBody(h({ "content-type": "application/json", "content-length": "10" })), false);
  assert.equal(isNonJsonBody(h({ "content-type": "Application/JSON; charset=utf-8", "content-length": "10" })), false);
});

test("form, plain-text and multipart bodies are refused", () => {
  assert.equal(isNonJsonBody(h({ "content-type": "text/plain", "content-length": "10" })), true);
  assert.equal(isNonJsonBody(h({ "content-type": "application/x-www-form-urlencoded", "content-length": "3" })), true);
  assert.equal(isNonJsonBody(h({ "content-type": "multipart/form-data; boundary=x", "content-length": "30" })), true);
});

test("a body with no Content-Type is refused; no body and no type is fine", () => {
  assert.equal(isNonJsonBody(h({ "content-length": "10" })), true);
  assert.equal(isNonJsonBody(h({ "transfer-encoding": "chunked" })), true);
  assert.equal(isNonJsonBody(h({})), false);
  assert.equal(isNonJsonBody(h({ "content-length": "0" })), false);
});

// TS-200: the body size cap.
test("the size cap is above the biggest guest list file the import takes", () => {
  // 2,000,000 characters of CSV (guestImportRequestSchema's limit), sent as JSON with every
  // character a quote or line break (each written as two) -- the worst plain-text case.
  const worstPlainCsv = JSON.stringify({ csv: '"\n'.repeat(1_000_000), mapping: {} });
  assert.ok(Buffer.byteLength(worstPlainCsv) <= MAX_JSON_BODY_BYTES, `${Buffer.byteLength(worstPlainCsv)} bytes`);
});

test("a body that says it's over the cap is refused by its headers alone", () => {
  assert.equal(declaresBodyTooLarge(h({ "content-length": String(MAX_JSON_BODY_BYTES + 1) })), true);
  assert.equal(declaresBodyTooLarge(h({ "content-length": String(MAX_JSON_BODY_BYTES) })), false);
  assert.equal(declaresBodyTooLarge(h({ "content-length": "120" })), false);
  assert.equal(declaresBodyTooLarge(h({})), false);
  assert.equal(declaresBodyTooLarge(h({ "content-length": "not a number" })), false);
});

/** A body sent in pieces, with no Content-Length. */
function streamOf(...pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

test("a body sent in pieces is read whole when it fits, and given up on once it's over the cap", async () => {
  assert.equal(await readBodyTextWithin(streamOf('{"name":', '"José"}'), 100), '{"name":"José"}');
  assert.equal(await readBodyTextWithin(null), "");
  assert.equal(await readBodyTextWithin(streamOf("x".repeat(60), "x".repeat(60)), 100), null);
  // Exactly at the cap is fine; one byte over isn't.
  assert.equal(await readBodyTextWithin(streamOf("x".repeat(100)), 100), "x".repeat(100));
  assert.equal(await readBodyTextWithin(streamOf("x".repeat(100), "y"), 100), null);
});
