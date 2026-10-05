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

// TS-171: one IPv6 connection usually has a whole /64 to pick addresses from.
test("IPv6 addresses are keyed by their /64 network, however they're written", () => {
  const key = "2001:db8:1:2::/64";
  for (const address of [
    "2001:db8:1:2::1",
    "2001:db8:1:2:ffff:ffff:ffff:ffff",
    "2001:0DB8:0001:0002:0000:0000:0000:0042",
    "[2001:db8:1:2::9]",
    "[2001:db8:1:2::9]:443",
    "2001:db8:1:2::7%eth0",
    "2001:db8:1:2:0:0:192.0.2.1",
  ]) {
    assert.equal(clientAddress(req({ "x-nf-client-connection-ip": address })), key, address);
  }
  assert.equal(clientAddress(req({ "x-nf-client-connection-ip": "2001:db8:1:3::1" })), "2001:db8:1:3::/64");
  assert.equal(clientAddress(req({ "x-nf-client-connection-ip": "::1" })), "0:0:0:0::/64");
});

test("an IPv4 address written the IPv6 way is the IPv4 address; plain IPv4 and non-addresses are unchanged", async () => {
  const { rateLimitAddress } = await import("./client-address");
  assert.equal(rateLimitAddress("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(rateLimitAddress("::ffff:cb00:7107"), "203.0.113.7");
  assert.equal(rateLimitAddress("203.0.113.7"), "203.0.113.7");
  assert.equal(rateLimitAddress("unknown"), "unknown");
  assert.equal(rateLimitAddress("198.51.100.4-made-up"), "198.51.100.4-made-up");
  // Not valid IPv6: left as it is rather than guessed at.
  assert.equal(rateLimitAddress("1:2:3"), "1:2:3");
  assert.equal(rateLimitAddress("1::2::3"), "1::2::3");
  assert.equal(rateLimitAddress("2001:db8::zz"), "2001:db8::zz");
});
