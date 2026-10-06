// TS-179: unit tests for the "this body isn't JSON" rule shared by proxy.ts and readJson(). Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNonJsonBody } from "./json-body";

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
