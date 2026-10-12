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

import { randomInt } from "node:crypto";

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
 * TS-102 cleanup marker. TS-171: the timestamp is written in letters -- a wedding name can't hold
 * 7 or more digits in a row (they'd read as a phone number), and a millisecond timestamp has 13. */
export function uniqueTitle(workerIndex: number, label: string): string {
  return tagTestName(`${label} ${workerIndex}-${numberToLetters(Date.now())}-${counter++}`);
}

/**
 * TS-163: a made-up network address (from 198.18.0.0/15, reserved for testing) for the
 * `x-forwarded-for` header. The app's per-address limits (sign-up, RSVP and invite links, sign-in)
 * then treat each test as its own visitor, so a full run from one machine never trips them --
 * just as many separate people wouldn't. Only honoured off Netlify; on Netlify the real address
 * always wins (see apps/web/src/lib/client-address.ts).
 */
//
// TS-176: no longer a fresh random pick each time -- 2^17 random addresses, with the app's
// counters kept for a day, gave a run a 1-2% chance of two tests sharing one and tripping a limit.
//
// TS-192: the TS-176 version still wrapped -- after 128 addresses a worker started handing out the
// same ones again -- and a worker restarted after a failure (same parallel index, fresh counter)
// repeated its predecessor's addresses. Now the 2^17 addresses are split into 256
// blocks of 512. Each worker *process* of a run gets its own block -- the run's
// random starting block (picked with crypto in globalSetup and handed to every worker through the
// environment) plus the process's TEST_WORKER_INDEX, which Playwright never reuses within a run,
// even for a restarted worker -- and hands its addresses out in order. Nothing wraps: a worker that
// needs more than a block, or a run with more worker processes than there are blocks, fails loudly
// instead of quietly sharing an address. Two runs only meet if their random blocks overlap, and
// globalTeardown deletes every counter keyed on a test address after each run, so a later run
// starts clean either way.
export const TEST_ADDRESS_BLOCK_SIZE = 512;
export const TEST_ADDRESS_BLOCKS = 2 ** 17 / TEST_ADDRESS_BLOCK_SIZE;
/** Environment variable globalSetup sets so every worker of a run agrees on the starting block. */
export const TEST_ADDRESS_RUN_ENV = "PW_TEST_ADDRESS_RUN_BLOCK";
/** The two /16 prefixes of 198.18.0.0/15 -- what globalTeardown matches to clear test counters. */
export const TEST_ADDRESS_PREFIXES = ["198.18.", "198.19."] as const;

/** A random starting block for this run (globalSetup calls this once). */
export function newTestAddressRunBlock(): string {
  return String(randomInt(TEST_ADDRESS_BLOCKS));
}

function runStartBlock(): number {
  const fromSetup = Number(process.env[TEST_ADDRESS_RUN_ENV]);
  if (Number.isInteger(fromSetup) && fromSetup >= 0 && fromSetup < TEST_ADDRESS_BLOCKS) return fromSetup;
  // Not started through globalSetup (shouldn't happen) -- pick once per process.
  const picked = Number(newTestAddressRunBlock());
  process.env[TEST_ADDRESS_RUN_ENV] = String(picked);
  return picked;
}

let addressesHandedOut = 0;
export function uniqueTestAddress(): string {
  const workerProcess = Number(process.env.TEST_WORKER_INDEX ?? 0);
  if (!Number.isInteger(workerProcess) || workerProcess < 0 || workerProcess >= TEST_ADDRESS_BLOCKS) {
    throw new Error(
      `uniqueTestAddress: worker process ${process.env.TEST_WORKER_INDEX} is past the ${TEST_ADDRESS_BLOCKS} address blocks a run has -- refusing to reuse an address.`,
    );
  }
  if (addressesHandedOut >= TEST_ADDRESS_BLOCK_SIZE) {
    throw new Error(
      `uniqueTestAddress: this worker has used all ${TEST_ADDRESS_BLOCK_SIZE} of its test addresses -- refusing to reuse one. Raise TEST_ADDRESS_BLOCK_SIZE in e2e/data/ids.ts.`,
    );
  }
  const block = (runStartBlock() + workerProcess) % TEST_ADDRESS_BLOCKS;
  const n = block * TEST_ADDRESS_BLOCK_SIZE + addressesHandedOut++;
  return `198.${18 + (n >> 16)}.${(n >> 8) & 255}.${n & 255}`;
}
