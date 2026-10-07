// TS-220: small pieces of the routes' answers after a change is saved (the TS-209 rule: never an
// error once something is saved), kept apart from the routes so they can be unit-tested.

/**
 * TS-220: an "RSVP link" / "New link" request whose email part failed (counting, the cooldown) after
 * the link itself may already have been made. Returns the guest's link as it is now, reported as
 * not emailed -- or null when no new link was saved (the route then answers the error as before):
 * the link can't be read, or "New link" still finds the link it had before.
 */
export async function rsvpLinkAfterFailure({
  regenerate,
  previousToken,
  readToken,
  appUrl,
  hasEmail,
}: {
  regenerate: boolean;
  /** For "New link": the guest's link before the request (null for "RSVP link"). */
  previousToken: string | null;
  /** Reads the guest's current link (making none when they already have one). */
  readToken: () => Promise<string | null>;
  appUrl: () => string;
  hasEmail: boolean;
}): Promise<{ url: string; emailed: false; emailFailed: boolean } | null> {
  let base: string;
  let token: string | null;
  try {
    base = appUrl();
    token = await readToken();
  } catch (err) {
    console.error("Reading the RSVP link back failed:", err);
    return null;
  }
  if (!token) return null;
  if (regenerate && token === previousToken) return null;
  return { url: `${base}/rsvp/${token}`, emailed: false, emailFailed: hasEmail };
}

/**
 * TS-220: whether a guest edit gave the guest their first email address, or corrected one --
 * worked out from the address the request sent and the guest as read before the edit, never from a
 * read-back after it (which can fail, and used to skip the RSVP email without a word).
 */
export function rsvpEmailChange(
  requestEmail: string | null | undefined,
  before: { email: string | null } | null
): { firstEmail: boolean; correctedEmail: boolean } {
  const sent = requestEmail?.trim() || null;
  if (!sent || !before) return { firstEmail: false, correctedEmail: false };
  const earlier = before.email?.trim() || null;
  return {
    firstEmail: !earlier,
    correctedEmail: !!earlier && earlier.toLowerCase() !== sent.toLowerCase(),
  };
}
