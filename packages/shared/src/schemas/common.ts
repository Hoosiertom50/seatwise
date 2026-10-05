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
