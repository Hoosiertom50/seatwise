import { z } from "zod";

// TS-174: bounds shared by every schema, so an out-of-range value is a 422 the person can fix
// rather than a value the database refuses (a server error).

/** The largest value a revision counter (a Postgres `integer`) can hold. */
export const MAX_REVISION = 2_147_483_647;

/** A revision the client last saw (FR-7.7 / TS-92): a whole number the database can store. */
export const revisionNumber = z.number().int().nonnegative().max(MAX_REVISION);

/** The optional `expectedRevision` every edit accepts. */
export const expectedRevisionField = revisionNumber.optional();

export const MIN_CALENDAR_YEAR = 1900;
export const MAX_CALENDAR_YEAR = 2200;

/** A calendar date (YYYY-MM-DD) in a sensible range -- the database refuses year 0000, for one. */
export const calendarDateField = z
  .string()
  .date()
  .refine((v) => {
    const year = Number(v.slice(0, 4));
    return year >= MIN_CALENDAR_YEAR && year <= MAX_CALENDAR_YEAR;
  }, `Use a date between ${MIN_CALENDAR_YEAR} and ${MAX_CALENDAR_YEAR}`);

/**
 * TS-200: a string whose length is checked before anything else, and nothing else runs when it's
 * too long. zod runs every check on a string even after one fails, so `.max(100).regex(...)` used
 * to run the pattern (and any .refine) on a 100,000-character value too -- and some of those
 * patterns take time that grows with the square of the length (a 40,000-character sign-up name
 * took about a second of server time). Here the value is trimmed (unless `trim: false`), held to
 * `max`, and only a value that fits is passed on to `then` for the remaining rules.
 */
export function lengthFirst<T extends z.ZodTypeAny>(max: number, then: T, opts: { trim?: boolean } = {}) {
  const base = opts.trim === false ? z.string() : z.string().trim();
  return base.max(max).pipe(then);
}
