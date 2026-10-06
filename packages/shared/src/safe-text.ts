import { z } from "zod";

// TS-180: free text people type (notes, labels, comments, vendor details) must not carry the NUL
// character -- Postgres refuses it, so it was a server error -- or other invisible control
// characters that garble emails, PDFs and spreadsheets. Line breaks and tabs are fine.
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export const CONTROL_CHARACTER_MESSAGE = "Can't contain hidden control characters — retype it or paste it as plain text";

/** Whether text holds a control character other than a line break or a tab (\r is allowed only in \r\n). */
export function hasForbiddenControlCharacter(value: string): boolean {
  return FORBIDDEN_CONTROL.test(value.replace(/\r\n/g, "\n"));
}

/**
 * TS-180: a free-text field of at most `max` characters with no control characters (see above).
 * Single-line fields (the default) are trimmed; `multiline` ones keep their spacing, with Windows
 * line endings made plain line breaks. `required` is the message for an empty value.
 */
export function safeText(max: number, opts: { multiline?: boolean; required?: string } = {}) {
  let base = z.string();
  if (!opts.multiline) base = base.trim();
  if (opts.required) base = base.min(1, opts.required);
  base = base.max(max);
  return base
    .refine((v) => !hasForbiddenControlCharacter(v), CONTROL_CHARACTER_MESSAGE)
    .transform((v) => (opts.multiline ? v.replace(/\r\n/g, "\n") : v));
}
