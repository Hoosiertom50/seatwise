// Stage 01: unit tests for the environment config schema (spec Section 7.3 acceptance criterion:
// "Invalid environment configuration fails with an actionable message").
import { test, expect } from "@playwright/test";
import { getEnv, __resetEnvCacheForTests } from "../../e2e/support/env";

test.beforeEach(() => {
  __resetEnvCacheForTests();
});

test("valid, minimal environment parses with documented defaults", () => {
  const env = getEnv({});
  expect(env.APP_URL).toBe("http://localhost:3000");
  expect(env.PRODUCTION_HOSTNAMES).toEqual([]);
  expect(env.PLAYWRIGHT_ALLOW_PRODUCTION).toBe(false);
  expect(env.CI).toBe(false);
});

test("a malformed APP_URL fails with an actionable, field-specific message", () => {
  expect(() => getEnv({ APP_URL: "not-a-url" })).toThrow(/APP_URL must be a valid absolute URL/);
});

test("PRODUCTION_HOSTNAMES is parsed into a trimmed, lowercased, filtered array", () => {
  const env = getEnv({ PRODUCTION_HOSTNAMES: " App.Example.com , , staging.example.com " });
  expect(env.PRODUCTION_HOSTNAMES).toEqual(["app.example.com", "staging.example.com"]);
});

test("PLAYWRIGHT_ALLOW_PRODUCTION only recognizes '1' as true", () => {
  expect(getEnv({ PLAYWRIGHT_ALLOW_PRODUCTION: "1" }).PLAYWRIGHT_ALLOW_PRODUCTION).toBe(true);
  __resetEnvCacheForTests();
  expect(getEnv({ PLAYWRIGHT_ALLOW_PRODUCTION: "0" }).PLAYWRIGHT_ALLOW_PRODUCTION).toBe(false);
});

test("an unrecognized value for PLAYWRIGHT_ALLOW_PRODUCTION fails rather than silently defaulting", () => {
  expect(() => getEnv({ PLAYWRIGHT_ALLOW_PRODUCTION: "yes" })).toThrow();
});

test("CI is treated as truthy for common CI-provider conventions", () => {
  expect(getEnv({ CI: "true" }).CI).toBe(true);
  __resetEnvCacheForTests();
  expect(getEnv({ CI: "1" }).CI).toBe(true);
  __resetEnvCacheForTests();
  expect(getEnv({}).CI).toBe(false);
});

test("getEnv caches after the first successful parse", () => {
  const first = getEnv({ APP_URL: "http://localhost:3000" });
  const second = getEnv({ APP_URL: "http://this-should-be-ignored:9999" });
  expect(second.APP_URL).toBe(first.APP_URL);
});
