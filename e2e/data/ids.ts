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

/**
 * TS-102: the marker every test-created wedding and seating-template name carries, so run-level
 * cleanup can identify test residue by an explicit, deliberate tag rather than by guessing from
 * ad-hoc naming patterns (`Owner-Only Wedding N-…`, `Rules Only N-…`, `Wedding A/B N-…`,
 * `Keyboard Wedding <token>`, `Alpha <token>`, …).
 *
 * Why a marker and not a pattern list: the sweep this feeds is a bulk delete run against the same
 * local database that holds real weddings. A pattern list is open-ended -- it silently fails to
 * match a name a future test invents (which then leaks), and worse, a loose pattern can match a
 * real wedding (which then gets deleted). `fill-existing-weddings.ts` in packages/db/prisma is
 * the precedent for what that costs. Matching on a marker that only this file can produce makes
 * both failure modes structural rather than a matter of care.
 *
 * Constrained to characters WEDDING_NAME_PATTERN accepts (see packages/shared/src/validation.ts:
 * letters, numbers, marks, space, and ' & , . ! - ), so a tagged name is still a valid wedding
 * name the app will accept.
 */
export const TEST_DATA_MARKER = "pwqa-fixture";

/**
 * Appends the marker to a name that wasn't built by `uniqueTitle` -- for the handful of tests
 * that construct a wedding name themselves (usually because the test asserts on the name's own
 * text, e.g. search/sort specs) and post it directly rather than going through
 * `WeddingDataSetup.createWedding`. Appending rather than prefixing keeps any
 * `startsWith`/search-by-prefix assertion on the caller's own label intact, and keeps relative
 * alphabetical ordering between names unchanged.
 */
export function tagTestName(name: string): string {
  return name.includes(TEST_DATA_MARKER) ? name : `${name} ${TEST_DATA_MARKER}`;
}

/** True when `name` was produced by `uniqueTitle`/`tagTestName` -- i.e. it is test-created data
 * that run-level cleanup may delete. The single source of truth the sweep matches on. */
export function isTestDataName(name: string): boolean {
  return name.includes(TEST_DATA_MARKER);
}

/** A unique, human-readable title for data that allows digits (e.g. wedding names), carrying the
 * TS-102 cleanup marker. */
export function uniqueTitle(workerIndex: number, label: string): string {
  return tagTestName(`${label} ${workerIndex}-${Date.now()}-${counter++}`);
}
