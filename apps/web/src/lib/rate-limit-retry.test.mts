// TS-186: unit tests for how long a sliding rate limit says to wait (the Retry-After header and
// "please wait N minutes"), packages/db/src/queries/rate-limit.ts. Run with
// `pnpm --filter @seatwise/web test`. Pure arithmetic -- no database.
import { test } from "node:test";
import assert from "node:assert/strict";

const { slidingRetryAfterSeconds } = await import("@seatwise/db");

const W = 900; // a 15-minute window

/** The count a sliding limit sees `afterSeconds` from now, for checking the answer. */
function weightedAt(current: number, previous: number, elapsedSeconds: number, afterSeconds: number): number {
  const t = elapsedSeconds + afterSeconds;
  if (t < W) return current + Math.ceil(previous * (1 - t / W));
  // The window has moved on: this one's count becomes the previous one.
  return Math.ceil(current * (1 - (t - W) / W));
}

test("with room under the limit now, the wait is the minimum of 1 second", () => {
  assert.equal(slidingRetryAfterSeconds({ current: 3, previous: 2, limit: 10, windowSeconds: W, elapsedSeconds: 100 }), 1);
});

test("over only because of the previous window: wait until enough of it has slid out", () => {
  // 10 tries last window, none this one, limit 10, 3 minutes in: ceil(10 x 0.8) = 8 counts now,
  // so one more try already fits.
  assert.equal(slidingRetryAfterSeconds({ current: 0, previous: 10, limit: 10, windowSeconds: W, elapsedSeconds: 180 }), 1);
  // 5 this window + ceil(10 x 0.8) = 13: one more fits once ceil(10 x (1 - f)) <= 4, i.e. f >= 0.6.
  const wait = slidingRetryAfterSeconds({ current: 5, previous: 10, limit: 10, windowSeconds: W, elapsedSeconds: 180 });
  assert.equal(wait, 0.6 * W - 180);
  assert.ok(weightedAt(5, 10, 180, wait) < 10, "fits after the wait");
  assert.ok(weightedAt(5, 10, 180, wait - 1) >= 10, "and not a second sooner");
});

test("over within this window alone: wait for it to end, and for enough of it to slide out of the next", () => {
  // 10 of 10 this window, 5 minutes in: the window ends in 10 minutes, and then 10 x (1 - f) must
  // come to 9 or less -- f >= 0.1, another 90 seconds.
  const wait = slidingRetryAfterSeconds({ current: 10, previous: 0, limit: 10, windowSeconds: W, elapsedSeconds: 300 });
  assert.equal(wait, 600 + 90);
  assert.ok(weightedAt(10, 0, 300, wait) < 10);
  assert.ok(weightedAt(10, 0, 300, wait - 1) >= 10);
});

test("never longer than the rest of this window plus one whole window", () => {
  // A limit of 1 used now holds for the longest a sliding count can.
  assert.equal(slidingRetryAfterSeconds({ current: 1, previous: 0, limit: 1, windowSeconds: W, elapsedSeconds: 300 }), 2 * W - 300);
  assert.ok(slidingRetryAfterSeconds({ current: 500, previous: 500, limit: 10, windowSeconds: W, elapsedSeconds: 0 }) <= 2 * W);
});

test("the answer always lets the next try in, across many cases", () => {
  for (const limit of [1, 3, 10, 30, 100]) {
    for (const current of [0, 1, limit - 1, limit, limit + 3]) {
      for (const previous of [0, 1, limit, 2 * limit]) {
        for (const elapsed of [0, 1, 299, 450, 899]) {
          if (current < 0) continue;
          const wait = slidingRetryAfterSeconds({ current, previous, limit, windowSeconds: W, elapsedSeconds: elapsed });
          assert.ok(wait >= 1, "at least a second");
          if (weightedAt(current, previous, elapsed, 0) >= limit) {
            assert.ok(weightedAt(current, previous, elapsed, wait) < limit, `fits after ${wait}s (${limit}/${current}/${previous}/${elapsed})`);
          }
        }
      }
    }
  }
});
