import { z } from "zod";

// TS-180: free text people type (notes, labels, comments, vendor details) must not carry the NUL
// character -- Postgres refuses it, so it was a server error -- or other invisible control
// characters that garble emails, PDFs and spreadsheets. Line breaks and tabs are fine.
// TS-190: nor the second set of control characters (U+0080 to U+009F), nor the invisible marks that
// flip the direction text is shown in (U+202A to U+202E, U+2066 to U+2069) -- they can make a name
// or a note read differently from what it really says.
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

export const CONTROL_CHARACTER_MESSAGE = "Can't contain hidden control characters — retype it or paste it as plain text";

// TS-198: free text can't hold the "couldn't read this character" mark (U+FFFD) either -- it
// means letters were already lost (a file or a copy in the wrong encoding), and saving it keeps
// the loss.

// TS-190: a single-line field (a name, a label) can't hold a line break.
export const LINE_BREAK_MESSAGE = "Can't contain line breaks — keep it on one line";

/** Whether text holds a control character other than a line break or a tab (\r is allowed only in \r\n). */
export function hasForbiddenControlCharacter(value: string): boolean {
  return FORBIDDEN_CONTROL.test(value.replace(/\r\n/g, "\n"));
}

/**
 * TS-180: a free-text field of at most `max` characters with no control characters (see above).
 * Single-line fields (the default) are trimmed and can't hold a line break; `multiline` ones keep
 * their spacing, with Windows line endings made plain line breaks. `required` is the message for
 * an empty value.
 */
export function safeText(max: number, opts: { multiline?: boolean; required?: string } = {}) {
  // TS-190: the length is counted after Windows line endings become plain line breaks -- that's
  // what's saved, so a note that fits isn't refused for its invisible \r characters.
  const normalized = opts.multiline ? z.string().transform((v) => v.replace(/\r\n/g, "\n")) : z.string().trim();
  let checked = z.string();
  if (opts.required) checked = checked.min(1, opts.required);
  checked = checked.max(max);
  return normalized.pipe(
    checked
      .refine((v) => opts.multiline || !/[\r\n]/.test(v), LINE_BREAK_MESSAGE)
      .refine((v) => !hasForbiddenControlCharacter(v), CONTROL_CHARACTER_MESSAGE)
  );
}
