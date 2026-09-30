// TS-73: unit tests for clientAddress -- the address the per-address rate limits key on. Run with
// `pnpm --filter @seatwise/web test` (no app server or database needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientAddress } from "./client-address";

const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

test("on Netlify, its own connection header wins over a made-up x-forwarded-for", () => {
  assert.equal(
    clientAddress(req({ "x-nf-client-connection-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6, 203.0.113.7" })),
    "203.0.113.7"
  );
});

test("a list or padded value in Netlify's header is reduced to its first address", () => {
  assert.equal(clientAddress(req({ "x-nf-client-connection-ip": " 203.0.113.7 , 10.0.0.1" })), "203.0.113.7");
});

test("without Netlify's header, the first x-forwarded-for entry is used (local dev, CI, e2e)", () => {
  assert.equal(clientAddress(req({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" })), "198.51.100.4");
});

test("then x-real-ip, then 'unknown'", () => {
  assert.equal(clientAddress(req({ "x-real-ip": "192.0.2.9" })), "192.0.2.9");
  assert.equal(clientAddress(req({})), "unknown");
});

test("an empty header falls through to the next one", () => {
  assert.equal(clientAddress(req({ "x-nf-client-connection-ip": "", "x-forwarded-for": "198.51.100.4" })), "198.51.100.4");
});
