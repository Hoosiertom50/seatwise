// TS-177 (Tom's decision): a guest-list count means two things -- invitations (guest records, each
// a household or a single person) and people (everyone they bring, i.e. the sum of headcounts).
// The dashboard showed one and the Guests tab the other under the same word, so the same wedding
// had two different "guest" counts. Both places now show both, the same way.
export function formatGuestCounts(invitations: number, people: number): string {
  return `${invitations} invitation${invitations === 1 ? "" : "s"} · ${people} ${people === 1 ? "person" : "people"}`;
}
