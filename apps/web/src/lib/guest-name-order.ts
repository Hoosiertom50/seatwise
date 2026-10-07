// TS-190: the order exports list guests in -- last name, then first name. Compared in two steps
// rather than as one joined string, so "Lee, Zed" still comes before "Leez, Amy".
// TS-214: the guest list and Day-of use it too, so the list doesn't change order after an add, an
// import or a walk-in (it sorted by last name only, while the server sorts by last name, first
// name, then id) -- and two guests with the same name are kept apart by id, as the server does.
export interface GuestNameParts {
  firstName: string;
  lastName: string;
  id?: string;
}

export function compareGuestNames(a: GuestNameParts, b: GuestNameParts): number {
  return (
    a.lastName.localeCompare(b.lastName) ||
    a.firstName.localeCompare(b.firstName) ||
    (a.id !== undefined && b.id !== undefined ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : 0)
  );
}
