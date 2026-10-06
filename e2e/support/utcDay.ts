// TS-192: the app's daily limits count calendar days in UTC (packages/db/src/queries/rate-limit.ts).
// A test that sets a daily counter directly in the database ("the address has had 5 emails today")
// and then asks the app about it gets the wrong answer if UTC midnight passes in between: the test
// wrote into yesterday's window and the app reads a fresh, empty one. Rare, but a test started at
// 11:59:30 PM UTC would fail for no reason -- and a flake like that costs a QA review.
//
// Call this at the start of such a test (before the first counter is set). When UTC midnight is
// closer than the test needs, it waits until just after midnight -- extending the test's own
// timeout by the wait, and saying so in the report -- so the whole test runs inside one UTC day.
import type { TestInfo } from "@playwright/test";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far past midnight to wait, so the server's clock (which may be slightly behind) agrees. */
const PAST_MIDNIGHT_MS = 5_000;

/** Milliseconds until the next UTC midnight from `nowMs`. */
export function msUntilUtcMidnight(nowMs: number = Date.now()): number {
  return DAY_MS - (nowMs % DAY_MS);
}

/**
 * How long to wait (0 when none is needed) so that a test needing `needMs` of one UTC day doesn't
 * cross midnight. Pure, so it can be unit-tested without a clock.
 */
export function waitNeededBeforeDailyCounters(nowMs: number, needMs: number): number {
  const left = msUntilUtcMidnight(nowMs);
  return left < needMs ? left + PAST_MIDNIGHT_MS : 0;
}

/**
 * Waits until safely past UTC midnight if fewer than `needMs` (default: 60 seconds, or the test's
 * own timeout if that's longer) are left in the UTC day. Records an annotation when it waits.
 */
export async function waitUntilSafelyInsideUtcDay(testInfo: TestInfo, needMs?: number): Promise<void> {
  const need = needMs ?? Math.max(60_000, testInfo.timeout);
  const waitMs = waitNeededBeforeDailyCounters(Date.now(), need);
  if (waitMs === 0) return;
  testInfo.annotations.push({
    type: "utc-midnight-wait",
    description: `Waited ${Math.ceil(waitMs / 1000)}s for UTC midnight to pass, so the daily counters this test sets and reads are in the same day.`,
  });
  // A real clock wait: nothing on the page can tell us when the UTC day changes.
  testInfo.setTimeout(testInfo.timeout + waitMs);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}
