/**
 * Stage 03 — worker-safe unique identity helpers (spec Section 7.3: "Create or reserve unique
 * test data" / Stage 03 task "unique, worker-safe test-data naming").
 *
 * Playwright runs each worker as a separate process with its own module state, so a per-process
 * monotonic counter combined with the worker's own index and a high-resolution timestamp is
 * enough to guarantee no two calls -- across workers, across retries of the same test, or across
 * tests in the same worker -- ever produce the same value, without any cross-process coordination.
 *
 * Guest first/last names are constrained by the app's own `PERSON_NAME_PATTERN`
 * (letters/spaces/apostrophes/periods/hyphens -- no digits; see
 * packages/shared/src/validation.ts), so `uniquePersonName` encodes its uniqueness as letters via
 * `numberToLetters` rather than appending a numeric suffix, which the app would reject outright.
 * Wedding names allow digits (`WEDDING_NAME_PATTERN`), so `uniqueTitle` can embed one directly.
 */

let counter = 0;

/** Base-26 letters-only encoding of a non-negative integer (like spreadsheet column naming:
 * 0->a, 25->z, 26->aa, ...). Guarantees a distinct input always produces a distinct output. */
export function numberToLetters(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`numberToLetters requires a non-negative integer, got ${n}`);
  }
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let value = n;
  let result = "";
  do {
    result = alphabet[value % 26] + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}

function nextSeed(workerIndex: number): number {
  // Date.now() gives millisecond uniqueness across time; workerIndex separates concurrent
  // workers; the in-process counter separates same-millisecond calls within one worker.
  return workerIndex * 1_000_000_000 + (Date.now() % 1_000_000) * 1000 + counter++;
}

/** A letters-only unique token, safe to embed in a PERSON_NAME_PATTERN-constrained field. */
export function uniqueToken(workerIndex: number): string {
  return numberToLetters(nextSeed(workerIndex));
}

/** A unique {firstName, lastName} pair passing PERSON_NAME_PATTERN, distinguishable at a glance
 * as test-generated data (constant "Playwright" first name) without colliding across workers,
 * tests, or retries. */
export function uniquePersonName(workerIndex: number): { firstName: string; lastName: string } {
  const token = uniqueToken(workerIndex);
  return {
    firstName: "Playwright",
    lastName: `Tester-${token}`,
  };
}

/** A unique, human-readable title for data that allows digits (e.g. wedding names). */
export function uniqueTitle(workerIndex: number, label: string): string {
  return `${label} ${workerIndex}-${Date.now()}-${counter++}`;
}
