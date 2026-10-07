// TS-208: how the Seating plan tab undoes one of its own moves. Kept pure (no React), so it's
// unit-tested.
//
// A move sends one guest to a table, but the server takes their whole must-sit-together group
// along, so more than one seat can change. Undo puts back what it can with one request:
// - the guest had a seat before: the group goes back to the guest's old table;
// - the guest had no seat, and a partner came from another table: the group goes to that partner's
//   old table (so the partner keeps a seat);
// - otherwise: only the guests this move seated lose their seat again -- a partner who was already
//   at that table stays (before, undo unseated the whole group, partner included);
// - and when the guest was already at that table and a partner moved in to join them (dragging a
//   guest onto their own table), it's recorded too (it used to be left out): undo takes that
//   partner's group back to the partner's old table.
//
// TS-221: when the group wasn't all at one table before the move (it was split -- one partner
// unseated, or at another table), undo can't put it back: the server moves the whole group, so a
// guest would land at a table they were never at. Such an undo is refused (undoWouldSplitGroup)
// instead of quietly moving the partner.

export interface UndoAssignment {
  guestId: string;
  tableId: string;
}

/** What one undo (and its redo) replays. */
export interface UndoPlan {
  /** The guest the undo/redo request is sent for (their group comes along). */
  guestId: string;
  /** Where `guestId` sits after the move -- undo only runs if they're still there. */
  toTableId: string;
  /** Where undo sends `guestId`'s group, or null to unseat. */
  undoTableId: string | null;
  /** With undoTableId null: exactly who loses their seat (the guests this move seated). */
  undoOnlyGuestIds: string[] | null;
  /** TS-221: where each seated guest sat just before the move (unseated guests aren't listed). */
  seatsBefore: Record<string, string>;
}

/** TS-221: what Undo says when putting the move back would split a must-sit-together group. */
export const UNDO_SPLITS_GROUP_MESSAGE = "Can't undo — that would split a must-sit-together group.";

export interface MustSitRule {
  guestAId: string;
  guestBId: string;
  type: string;
}

/**
 * TS-221: everyone the server moves along with `guestId` -- connected to them by a chain of
 * must-sit-together rules, leaving out guests marked not attending (as the server does). Includes
 * `guestId` itself.
 */
export function mustSitGroup(
  guestId: string,
  rules: readonly MustSitRule[],
  notAttending: ReadonlySet<string> = new Set()
): string[] {
  const links = new Map<string, string[]>();
  for (const r of rules) {
    if (r.type !== "MUST_SIT_TOGETHER" || notAttending.has(r.guestAId) || notAttending.has(r.guestBId)) continue;
    links.set(r.guestAId, [...(links.get(r.guestAId) ?? []), r.guestBId]);
    links.set(r.guestBId, [...(links.get(r.guestBId) ?? []), r.guestAId]);
  }
  const seen = new Set([guestId]);
  const queue = [guestId];
  while (queue.length > 0) {
    for (const next of links.get(queue.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

/**
 * TS-221: true when undoing `plan` would put a member of `group` (the undo guest's must-sit group,
 * see mustSitGroup) at a table they weren't at before the move -- the group was split then, and
 * moving it back together isn't an undo. Taking away just the seats a move gave is always exact.
 */
export function undoWouldSplitGroup(plan: UndoPlan, group: readonly string[]): boolean {
  if (plan.undoTableId === null) return false;
  return group.some((g) => (plan.seatsBefore[g] ?? null) !== plan.undoTableId);
}

/**
 * The undo for moving `guestId` to `tableId`, given the plan's seats just before and just after
 * the move. Null when no seat changed (nothing to undo).
 */
export function undoPlanFor(
  guestId: string,
  tableId: string,
  before: readonly UndoAssignment[],
  after: readonly UndoAssignment[]
): UndoPlan | null {
  const wasAt = new Map(before.map((a) => [a.guestId, a.tableId]));
  const seatsBefore = Object.fromEntries(wasAt);
  // Everyone whose seat this move changed (a move never unseats anyone).
  const changed = after.filter((a) => wasAt.get(a.guestId) !== a.tableId);
  if (changed.length === 0) return null;
  const prior = wasAt.get(guestId) ?? null;
  const cameFromTable = changed.filter((a) => a.guestId !== guestId && wasAt.has(a.guestId));
  const newlySeated = changed.filter((a) => !wasAt.has(a.guestId)).map((a) => a.guestId);

  if (prior !== null && prior !== tableId) {
    return { guestId, toTableId: tableId, undoTableId: prior, undoOnlyGuestIds: null, seatsBefore };
  }
  if (prior === null) {
    if (cameFromTable.length > 0) {
      return { guestId, toTableId: tableId, undoTableId: wasAt.get(cameFromTable[0].guestId)!, undoOnlyGuestIds: null, seatsBefore };
    }
    return { guestId, toTableId: tableId, undoTableId: null, undoOnlyGuestIds: newlySeated, seatsBefore };
  }
  // The guest was already at that table; partners joined them.
  if (cameFromTable.length > 0) {
    const partner = cameFromTable[0];
    return { guestId: partner.guestId, toTableId: tableId, undoTableId: wasAt.get(partner.guestId)!, undoOnlyGuestIds: null, seatsBefore };
  }
  return { guestId: newlySeated[0], toTableId: tableId, undoTableId: null, undoOnlyGuestIds: newlySeated, seatsBefore };
}
