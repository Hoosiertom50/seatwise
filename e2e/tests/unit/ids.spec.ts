/**
 * Stage 03 — unit tests for e2e/data/ids.ts's worker-safe unique-identity helpers. Pure functions,
 * no browser or app dependency, so these run under the "chromium" Playwright project (testDir
 * ./e2e/tests) without ever launching a browser -- no test here requests the `page`/`context`
 * fixture.
 */

import { test, expect } from "@playwright/test";
import { numberToLetters, uniqueToken, uniquePersonName, uniqueTitle } from "../../data/ids.js";

// Mirrors packages/shared/src/validation.ts's PERSON_NAME_PATTERN. Not imported directly: this
// project's tsconfig deliberately excludes packages/ (see tsconfig.json) and the root package.json
// has no workspace dependency on @seatwise/shared, so e2e/ stays self-contained rather than
// reaching into the app's own source tree. Keep this in sync if the app's pattern changes.
const PERSON_NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u;

test.describe("numberToLetters", () => {
  test("encodes the spreadsheet-column boundary cases", () => {
    expect(numberToLetters(0)).toBe("a");
    expect(numberToLetters(25)).toBe("z");
    expect(numberToLetters(26)).toBe("aa");
    expect(numberToLetters(27)).toBe("ab");
    expect(numberToLetters(701)).toBe("zz");
    expect(numberToLetters(702)).toBe("aaa");
  });

  test("is injective across a large contiguous range (no two inputs collide)", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 10_000; n++) {
      const letters = numberToLetters(n);
      expect(seen.has(letters)).toBe(false);
      seen.add(letters);
    }
  });

  test("never produces a digit or any character outside a-z", () => {
    for (const n of [0, 1, 26, 27, 675, 676, 999_999]) {
      expect(numberToLetters(n)).toMatch(/^[a-z]+$/);
    }
  });

  test("rejects negative and non-integer input", () => {
    expect(() => numberToLetters(-1)).toThrow();
    expect(() => numberToLetters(1.5)).toThrow();
    expect(() => numberToLetters(Number.NaN)).toThrow();
  });
});

test.describe("uniqueToken / uniquePersonName", () => {
  test("uniqueToken never repeats across many calls for the same worker", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const token = uniqueToken(0);
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
    }
  });

  test("uniqueToken separates different worker indexes even called at the same instant", () => {
    const a = uniqueToken(0);
    const b = uniqueToken(1);
    expect(a).not.toBe(b);
  });

  test("uniquePersonName produces a first/last name that satisfies the app's PERSON_NAME_PATTERN", () => {
    const { firstName, lastName } = uniquePersonName(0);
    expect(firstName).toMatch(PERSON_NAME_PATTERN);
    expect(lastName).toMatch(PERSON_NAME_PATTERN);
  });

  test("uniquePersonName never embeds a digit in either name (the constraint that broke the first draft of the reference test)", () => {
    const { firstName, lastName } = uniquePersonName(3);
    expect(firstName).not.toMatch(/\d/);
    expect(lastName).not.toMatch(/\d/);
  });

  test("uniquePersonName is unique across repeated calls for the same worker", () => {
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { firstName, lastName } = uniquePersonName(0);
      const key = `${firstName} ${lastName}`;
      expect(names.has(key)).toBe(false);
      names.add(key);
    }
  });
});

test.describe("uniqueTitle", () => {
  test("embeds the given label and worker index", () => {
    const title = uniqueTitle(2, "Playwright Wedding");
    expect(title).toContain("Playwright Wedding");
    expect(title.startsWith("Playwright Wedding 2-")).toBe(true);
  });

  test("is unique across repeated calls even within the same millisecond", () => {
    const titles = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const title = uniqueTitle(0, "Wedding");
      expect(titles.has(title)).toBe(false);
      titles.add(title);
    }
  });
});
