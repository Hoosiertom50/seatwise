// FR-12.2 / TS-153: the RSVP cutoff is a date, not a time -- responses are accepted through the
// whole cutoff day *wherever the guest is*. Seatwise's server runs on UTC, so "23:59:59 server
// time" used to close RSVPs at about 7-8pm on the cutoff day for US guests. The day now ends when
// it has ended everywhere on Earth (UTC-12), i.e. 12:00 UTC the next day.
export function isRsvpCutoffPast(rsvpCutoffDate: string | null, now: Date = new Date()): boolean {
  if (!rsvpCutoffDate) return false;
  const [y, m, d] = rsvpCutoffDate.split("-").map(Number);
  const closesAt = Date.UTC(y, m - 1, d + 1, 12, 0, 0);
  return now.getTime() >= closesAt;
}
