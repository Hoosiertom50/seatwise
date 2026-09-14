/**
 * Stage 03 — unit tests for e2e/support/redaction.ts against representative secrets (spec Section
 * 7.4 / Stage 03 task: "verify redaction against representative secrets"). Pure function, no
 * browser needed.
 */

import { test, expect } from "@playwright/test";
import { redact, DEFAULT_REDACTION_RULES } from "../../support/redaction.js";

test.describe("redact — representative secrets", () => {
  test("redacts an Authorization header", () => {
    const input = "GET /api/v1/weddings\nauthorization: Basic dG9tOnN1cGVyc2VjcmV0\nAccept: */*";
    const out = redact(input);
    expect(out).not.toContain("dG9tOnN1cGVyc2VjcmV0");
    expect(out).toContain("authorization: [REDACTED]");
  });

  test("redacts a Bearer token embedded mid-line", () => {
    const input = "fetch failed: Authorization header was Bearer abc123.def-456_ghi789 (401)";
    const out = redact(input);
    expect(out).not.toContain("abc123.def-456_ghi789");
    expect(out).toContain("Bearer [REDACTED]");
  });

  test("redacts a JWT wherever it appears, even outside a Bearer/header context", () => {
    // Structurally valid-looking JWT shape (header.payload.signature), not a real token.
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc19pc19ub3RfYV9yZWFsX3NpZ25hdHVyZQ";
    const out = redact(`session cookie value observed in test log: ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("[REDACTED_JWT]");
  });

  test("redacts a Set-Cookie response header", () => {
    const input = "set-cookie: seatwise_session=s%3AabCdEf123.signature; HttpOnly; Path=/";
    const out = redact(input);
    expect(out).not.toContain("s%3AabCdEf123");
    expect(out).toContain("set-cookie: [REDACTED]");
  });

  test("redacts a Cookie request header", () => {
    const input = "cookie: seatwise_session=topsecretvalue";
    const out = redact(input);
    expect(out).not.toContain("topsecretvalue");
    expect(out).toContain("cookie: [REDACTED]");
  });

  test("redacts every cookie in a multi-cookie header, not just the first (stage-03 audit finding)", () => {
    const input = "cookie: session=SECRET1; other=SECRET2; third=SECRET3";
    const out = redact(input);
    expect(out).not.toContain("SECRET1");
    expect(out).not.toContain("SECRET2");
    expect(out).not.toContain("SECRET3");
    expect(out).toBe("cookie: [REDACTED]");
  });

  test("cookie-header rule's negative lookbehind skips a compound token like xsrf-cookie:", () => {
    // Guards against eating part of an unrelated compound identifier immediately preceded by a
    // hyphen or word character -- it does NOT attempt to distinguish header text from prose (a
    // documented, accepted limitation of pattern-based, rather than field-aware, redaction: see
    // this module's own top-of-file comment).
    const input = "xsrf-cookie: not-actually-a-cookie-header-value";
    expect(redact(input)).toBe(input);
  });

  test("redacts sensitive JSON body fields (password, token, apiKey, secret, and their snake_case/OAuth variants)", () => {
    const body = JSON.stringify({
      email: "planner@example.invalid",
      password: "hunter2",
      token: "abc.def.ghi",
      apiKey: "sk-live-1234567890",
      api_key: "sk-live-0987654321",
      secret: "shh-dont-tell",
      accessToken: "at-1234",
      access_token: "at-5678",
      refreshToken: "rt-1234",
      refresh_token: "rt-5678",
    });
    const out = redact(body);
    for (const secret of [
      "hunter2",
      "abc.def.ghi",
      "sk-live-1234567890",
      "sk-live-0987654321",
      "shh-dont-tell",
      "at-1234",
      "at-5678",
      "rt-1234",
      "rt-5678",
    ]) {
      expect(out).not.toContain(secret);
    }
    // Non-sensitive fields are left untouched.
    expect(out).toContain("planner@example.invalid");
  });

  test("redacts sensitive fields in URL/query-string form", () => {
    const url = "https://app.example.invalid/reset?token=abc123&next=/dashboard&apiKey=sk-999";
    const out = redact(url);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("sk-999");
    expect(out).toContain("token=[REDACTED]");
    expect(out).toContain("apiKey=[REDACTED]");
    // Unrelated query params survive.
    expect(out).toContain("next=/dashboard");
  });

  test("is idempotent: redacting already-redacted text changes nothing further", () => {
    const input = "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig";
    const once = redact(input);
    const twice = redact(once);
    expect(twice).toBe(once);
  });

  test("leaves ordinary, non-sensitive text completely unchanged", () => {
    const input = "The new guest \"Playwright Tester-abc\" appears as a row in the Guests tab list.";
    expect(redact(input)).toBe(input);
  });

  test("applies caller-supplied extraRules in addition to the defaults", () => {
    const input = "internalCustomerId: CUST-90210";
    const out = redact(input, [
      { name: "customer-id", pattern: /CUST-\d+/g, replacement: "[REDACTED_CUSTOMER_ID]" },
    ]);
    expect(out).toContain("[REDACTED_CUSTOMER_ID]");
    expect(out).not.toContain("CUST-90210");
  });

  test("every default rule has a unique name (so a gap can be diagnosed rule-by-rule)", () => {
    const names = DEFAULT_REDACTION_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
