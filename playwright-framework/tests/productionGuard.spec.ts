// Stage 01: unit tests for the production/mutation guard. These use Playwright Test purely as a
// TypeScript-native test runner (no `page`/browser fixture involved) -- pure-function logic gets
// pure-function tests, matching spec Section 8.2's "quality" idea of testing at the right level.
import { test, expect } from "@playwright/test";
import { resolveIsProduction, assertMutationAllowed, ProductionMutationBlockedError } from "../../e2e/support/productionGuard";

test.describe("resolveIsProduction", () => {
  test("an empty production hostname list never matches, by construction", () => {
    expect(resolveIsProduction("https://app.example.com", [])).toBe(false);
    expect(resolveIsProduction("http://localhost:3000", [])).toBe(false);
  });

  test("matches a configured hostname case-insensitively", () => {
    expect(resolveIsProduction("https://APP.example.com", ["app.example.com"])).toBe(true);
  });

  test("does not match an unrelated hostname", () => {
    expect(resolveIsProduction("https://staging.example.com", ["app.example.com"])).toBe(false);
  });

  test("a malformed base URL is treated as non-production rather than throwing", () => {
    expect(resolveIsProduction("not-a-url", ["app.example.com"])).toBe(false);
  });
});

test.describe("assertMutationAllowed", () => {
  const baseEnv = { PRODUCTION_HOSTNAMES: [] as string[], PLAYWRIGHT_ALLOW_PRODUCTION: false };

  test("non-production target with a mutating selection is always allowed", () => {
    expect(() =>
      assertMutationAllowed({
        baseURL: "http://localhost:3000",
        hasMutatingSelection: true,
        env: baseEnv,
      })
    ).not.toThrow();
  });

  test("production target with a mutating selection is always blocked, even with approval set", () => {
    const env = { PRODUCTION_HOSTNAMES: ["app.example.com"], PLAYWRIGHT_ALLOW_PRODUCTION: true };
    expect(() =>
      assertMutationAllowed({
        baseURL: "https://app.example.com",
        hasMutatingSelection: true,
        env,
      })
    ).toThrow(ProductionMutationBlockedError);
  });

  test("production target with a read-only selection is blocked without explicit approval", () => {
    const env = { PRODUCTION_HOSTNAMES: ["app.example.com"], PLAYWRIGHT_ALLOW_PRODUCTION: false };
    expect(() =>
      assertMutationAllowed({
        baseURL: "https://app.example.com",
        hasMutatingSelection: false,
        env,
      })
    ).toThrow(/requires PLAYWRIGHT_ALLOW_PRODUCTION=1/);
  });

  test("production target with a read-only selection is allowed with explicit approval", () => {
    const env = { PRODUCTION_HOSTNAMES: ["app.example.com"], PLAYWRIGHT_ALLOW_PRODUCTION: true };
    expect(() =>
      assertMutationAllowed({
        baseURL: "https://app.example.com",
        hasMutatingSelection: false,
        env,
      })
    ).not.toThrow();
  });

  test("an unrecognized host is never treated as production even with an empty allow-list and no approval", () => {
    expect(() =>
      assertMutationAllowed({
        baseURL: "https://some-other-host.example.com",
        hasMutatingSelection: true,
        env: baseEnv,
      })
    ).not.toThrow();
  });
});
