// TS-190: the order exports list guests in -- last name, then first name. Compared in two steps
// rather than as one joined string, so "Lee, Zed" still comes before "Leez, Amy".
export interface GuestNameParts {
  firstName: string;
  lastName: string;
}

export function compareGuestNames(a: GuestNameParts, b: GuestNameParts): number {
  return a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);
}
