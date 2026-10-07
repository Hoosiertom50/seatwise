/**
 * TS-215 — unit tests for two pieces of e2e test-database housekeeping. Pure functions, no
 * database, app or browser (the `unit` project).
 *   - A counter preset made within a few seconds of its window's end (a daily counter at 00:00 UTC)
 *     waits for the next window, so the test's own request lands in the same window.
 *   - The run-end sweep drops only triggers/functions named exactly like breakNotificationsFor's.
 */

import { test, expect } from "@playwright/test";
import { waitBeforePresetMs, WINDOW_END_MARGIN_MS } from "../../support/testDatabase.js";
import { TEST_TRIGGER_NAME } from "../../support/globalTeardown.js";

const DAY = 86_400;
const midnightUtc = Date.UTC(2026, 9, 8, 0, 0, 0);

test.describe("waitBeforePresetMs", () => {
  test("no wait in the middle of a window", () => {
    expect(waitBeforePresetMs(DAY, midnightUtc - 6 * 3_600_000)).toBe(0);
    expect(waitBeforePresetMs(DAY, midnightUtc + 1_000)).toBe(0);
  });

  test("just before 00:00 UTC, waits until just after it", () => {
    const now = midnightUtc - 5_000;
    const wait = waitBeforePresetMs(DAY, now);
    expect(wait).toBeGreaterThan(5_000);
    expect(wait).toBeLessThanOrEqual(WINDOW_END_MARGIN_MS + 1_000);
    expect(now + wait).toBeGreaterThan(midnightUtc);
  });

  test("shorter windows (15 minutes) are handled the same way", () => {
    const quarter = Date.UTC(2026, 9, 7, 14, 15, 0);
    expect(waitBeforePresetMs(900, quarter - 2_000)).toBeGreaterThan(2_000);
    expect(waitBeforePresetMs(900, quarter - 60_000)).toBe(0);
  });
});

test.describe("TEST_TRIGGER_NAME", () => {
  test("matches only pw_fail_notify_ followed by a test account id", () => {
    expect(TEST_TRIGGER_NAME.test(`pw_fail_notify_${"0123456789abcdef".repeat(2)}`)).toBe(true);
    expect(TEST_TRIGGER_NAME.test("pw_fail_notify_")).toBe(false);
    expect(TEST_TRIGGER_NAME.test("pw_fail_notify_abc; DROP TABLE users")).toBe(false);
    expect(TEST_TRIGGER_NAME.test("notifications_audit")).toBe(false);
  });
});
