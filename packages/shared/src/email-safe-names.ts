import { PERSON_NAME_PATTERN, WEDDING_NAME_PATTERN, looksLikePhoneNumber, looksLikeWebAddress } from "./validation";

// TS-156 / TS-163: names typed by planners go into emails Seatwise sends to other people (invites,
// RSVP links). Today's rules stop a name reading as a web address, but names saved before those
// rules could hold anything -- so an email only uses a name that passes them now, and otherwise
// says something neutral instead.

/** The person's name if it reads as one, otherwise null. */
export function emailSafePersonName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 100 && PERSON_NAME_PATTERN.test(trimmed) && !looksLikeWebAddress(trimmed)
    ? trimmed
    : null;
}

/** The wedding's name if it reads as one, otherwise null. */
export function emailSafeWeddingName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length > 0 &&
    trimmed.length <= 200 &&
    WEDDING_NAME_PATTERN.test(trimmed) &&
    !looksLikeWebAddress(trimmed) &&
    // TS-171
    !looksLikePhoneNumber(trimmed)
    ? trimmed
    : null;
}
