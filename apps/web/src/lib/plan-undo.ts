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
  // Everyone whose seat this move changed (a move never unseats anyone).
  const changed = after.filter((a) => wasAt.get(a.guestId) !== a.tableId);
  if (changed.length === 0) return null;
  const prior = wasAt.get(guestId) ?? null;
  const cameFromTable = changed.filter((a) => a.guestId !== guestId && wasAt.has(a.guestId));
  const newlySeated = changed.filter((a) => !wasAt.has(a.guestId)).map((a) => a.guestId);

  if (prior !== null && prior !== tableId) {
    return { guestId, toTableId: tableId, undoTableId: prior, undoOnlyGuestIds: null };
  }
  if (prior === null) {
    if (cameFromTable.length > 0) {
      return { guestId, toTableId: tableId, undoTableId: wasAt.get(cameFromTable[0].guestId)!, undoOnlyGuestIds: null };
    }
    return { guestId, toTableId: tableId, undoTableId: null, undoOnlyGuestIds: newlySeated };
  }
  // The guest was already at that table; partners joined them.
  if (cameFromTable.length > 0) {
    const partner = cameFromTable[0];
    return { guestId: partner.guestId, toTableId: tableId, undoTableId: wasAt.get(partner.guestId)!, undoOnlyGuestIds: null };
  }
  return { guestId: newlySeated[0], toTableId: tableId, undoTableId: null, undoOnlyGuestIds: newlySeated };
}
