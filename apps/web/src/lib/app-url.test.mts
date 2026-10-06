// TS-178: unit tests for where the app's own address comes from (app-url.ts) -- every emailed and
// shared link, and the session cookie's Secure flag. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appBaseUrl, AppUrlNotConfiguredError } from "./app-url";

test("locally (development and tests) APP_URL is used when set, otherwise localhost", () => {
  assert.equal(appBaseUrl({ NODE_ENV: "development" }), "http://localhost:3000");
  assert.equal(appBaseUrl({ NODE_ENV: "test" }), "http://localhost:3000");
  assert.equal(appBaseUrl({}), "http://localhost:3000");
  assert.equal(appBaseUrl({ NODE_ENV: "development", APP_URL: "http://localhost:4000/" }), "http://localhost:4000");
});

test("a production build uses its https:// APP_URL, without a trailing slash", () => {
  assert.equal(appBaseUrl({ NODE_ENV: "production", APP_URL: "https://seatwise-app.netlify.app" }), "https://seatwise-app.netlify.app");
  assert.equal(appBaseUrl({ NODE_ENV: "production", APP_URL: " https://seatwise.example/ " }), "https://seatwise.example");
});

test("a production build refuses a missing, plain-http or malformed APP_URL", () => {
  for (const APP_URL of [undefined, "", "http://seatwise.example", "seatwise.example", "ftp://seatwise.example"]) {
    assert.throws(() => appBaseUrl({ NODE_ENV: "production", APP_URL }), AppUrlNotConfiguredError, String(APP_URL));
  }
});

test("a production build run on this machine may use http://localhost", () => {
  assert.equal(appBaseUrl({ NODE_ENV: "production", APP_URL: "http://localhost:3000" }), "http://localhost:3000");
  assert.equal(appBaseUrl({ NODE_ENV: "production", APP_URL: "http://127.0.0.1:3000" }), "http://127.0.0.1:3000");
});

test("CI's production build (emails only logged, no APP_URL) keeps the localhost fallback", () => {
  assert.equal(appBaseUrl({ NODE_ENV: "production", EMAIL_TRANSPORT: "log" }), "http://localhost:3000");
  // Logging email doesn't excuse a wrong address that *is* set.
  assert.throws(() => appBaseUrl({ NODE_ENV: "production", EMAIL_TRANSPORT: "log", APP_URL: "http://seatwise.example" }), AppUrlNotConfiguredError);
});
