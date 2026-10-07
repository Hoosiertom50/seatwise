// TS-197 / TS-208: which tables Day-of mode offers in a guest's "Move to…" and "Seat at…" lists,
// and in the walk-in form -- the ones the server would accept for the guest's whole
// must-sit-together group. Kept pure (no React), so it's unit-tested.

export interface ChoiceGuest {
  id: string;
  headcount: number;
  requiresAccessibleTable: boolean;
  dayOfAttendance: string;
}
export interface ChoiceTable {
  id: string;
  label: string;
  capacity: number;
  isAccessible: boolean;
  isRestricted: boolean;
  requiredGuestIds: string[];
}
export interface ChoiceAssignment {
  guestId: string;
  tableId: string;
}
export interface ChoiceRelationship {
  guestAId: string;
  guestBId: string;
  type: string;
}
export interface ChoiceContext<T extends ChoiceTable = ChoiceTable> {
  guests: readonly ChoiceGuest[];
  tables: readonly T[];
  assignments: readonly ChoiceAssignment[];
  relationships: readonly ChoiceRelationship[];
}

/** "A", "A and B", "A, B and C". */
export function nameList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The guest and everyone tied to them by a chain of must-sit-together rules -- attending guests
 * only, as on the server (a rule with someone not attending doesn't apply today). */
export function mustSitGroup(guestId: string, ctx: Pick<ChoiceContext, "guests" | "relationships">): string[] {
  const attending = new Set(ctx.guests.filter((g) => g.dayOfAttendance === "ATTENDING").map((g) => g.id));
  if (!attending.has(guestId)) return [guestId];
  const partners = new Map<string, string[]>();
  for (const r of ctx.relationships) {
    if (r.type !== "MUST_SIT_TOGETHER" || !attending.has(r.guestAId) || !attending.has(r.guestBId)) continue;
    partners.set(r.guestAId, [...(partners.get(r.guestAId) ?? []), r.guestBId]);
    partners.set(r.guestBId, [...(partners.get(r.guestBId) ?? []), r.guestAId]);
  }
  const group = new Set([guestId]);
  const queue = [guestId];
  while (queue.length > 0) {
    for (const partner of partners.get(queue.pop()!) ?? []) {
      if (!group.has(partner)) {
        group.add(partner);
        queue.push(partner);
      }
    }
  }
  return [...group];
}

/**
 * The tables a guest can be moved to (when seated) or seated at (when not), each with its free
 * seats -- or, with `guestId` null, the tables a new walk-in (one person, on no list and in no
 * rule) can be seated at. A table is offered only when the server would accept it for the guest's
 * whole must-sit-together group:
 * - enough free seats for everyone in the group (by party size; the group's own seats there count
 *   as free, since they'd just stay);
 * - accessible, if anyone in the group needs that;
 * - not a Restricted table unless everyone is on its list, and not any other table when someone is
 *   on a Restricted table's list;
 * - TS-208: nobody already seated there has a "must not sit together" rule with anyone in the group.
 * The guest's own table, and a table the whole group is already at, aren't offered.
 */
export function tableChoicesFor<T extends ChoiceTable>(guestId: string | null, ctx: ChoiceContext<T>): { table: T; free: number }[] {
  const byId = new Map(ctx.guests.map((g) => [g.id, g]));
  const tableOf = new Map(ctx.assignments.map((a) => [a.guestId, a.tableId]));
  const groupIds = guestId ? mustSitGroup(guestId, ctx) : [];
  const group = groupIds.map((id) => byId.get(id)).filter((g): g is ChoiceGuest => g !== undefined);
  if (guestId && group.length === 0) return [];
  const inGroup = new Set(groupIds);
  // A walk-in is one person who needs nothing special.
  const needed = guestId ? group.reduce((sum, g) => sum + g.headcount, 0) : 1;
  const needsAccessible = group.some((g) => g.requiresAccessibleTable);
  const requiredAt = new Set(
    group.flatMap((g) => ctx.tables.filter((t) => t.isRestricted && t.requiredGuestIds.includes(g.id)).map((t) => t.id))
  );
  const mustNot = new Set<string>();
  for (const r of ctx.relationships) {
    if (r.type !== "MUST_NOT_SIT_TOGETHER") continue;
    if (inGroup.has(r.guestAId)) mustNot.add(r.guestBId);
    if (inGroup.has(r.guestBId)) mustNot.add(r.guestAId);
  }
  const fromTableId = guestId ? tableOf.get(guestId) : undefined;
  const seatedAt = new Map<string, number>();
  const groupAt = new Map<string, number>();
  const occupantsAt = new Map<string, string[]>();
  for (const a of ctx.assignments) {
    const size = byId.get(a.guestId)?.headcount ?? 1;
    seatedAt.set(a.tableId, (seatedAt.get(a.tableId) ?? 0) + size);
    if (inGroup.has(a.guestId)) groupAt.set(a.tableId, (groupAt.get(a.tableId) ?? 0) + size);
    else occupantsAt.set(a.tableId, [...(occupantsAt.get(a.tableId) ?? []), a.guestId]);
  }
  return ctx.tables
    .filter((table) => {
      if (table.id === fromTableId) return false;
      if (group.length > 0 && group.every((g) => tableOf.get(g.id) === table.id)) return false;
      const room = table.capacity - ((seatedAt.get(table.id) ?? 0) - (groupAt.get(table.id) ?? 0));
      if (room < needed) return false;
      if (needsAccessible && !table.isAccessible) return false;
      if (table.isRestricted && (group.length === 0 || !group.every((g) => table.requiredGuestIds.includes(g.id)))) return false;
      if ([...requiredAt].some((id) => id !== table.id)) return false;
      if ((occupantsAt.get(table.id) ?? []).some((id) => mustNot.has(id))) return false;
      return true;
    })
    .map((table) => ({ table, free: table.capacity - (seatedAt.get(table.id) ?? 0) }));
}

/**
 * TS-208: what Day-of says after seating or moving a guest -- everyone who ended up at the table
 * because of it (a must-sit-together partner seated elsewhere comes along), the guest first:
 * "Seated A at T2." when none of them had a seat, "Moved A and B to T2." when someone did.
 * Null when nobody's seat changed.
 */
export function seatResultMessage(
  guestId: string,
  tableId: string,
  before: readonly (ChoiceAssignment & { guestName?: string })[],
  after: readonly (ChoiceAssignment & { guestName: string; tableLabel: string })[]
): string | null {
  const wasAt = new Map(before.map((a) => [a.guestId, a.tableId]));
  const changed = after
    .filter((a) => a.tableId === tableId && wasAt.get(a.guestId) !== tableId)
    .sort((a, b) => (a.guestId === guestId ? -1 : b.guestId === guestId ? 1 : a.guestName.localeCompare(b.guestName)));
  if (changed.length === 0) return null;
  const label = changed[0].tableLabel;
  const names = nameList(changed.map((a) => a.guestName));
  return changed.some((a) => wasAt.has(a.guestId)) ? `Moved ${names} to ${label}.` : `Seated ${names} at ${label}.`;
}
