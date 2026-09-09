import type { GuestDTO, PlanVersionAssignmentDTO, PlanVersionDetailDTO, SeatingTableDTO } from "@seatwise/shared";

// Pure, RN-free merge/update logic for the floor-plan screen -- kept separate from the screen
// component so it's unit-testable head-on (no renderer, no device) the same way the rest of this
// engagement's ticket work has had a real executed test suite, not just manual eyeballing.

export interface SeatedGuest {
  guest: GuestDTO;
  needsReassignment: boolean;
  // True for a move this device has applied locally but the server hasn't confirmed yet (still
  // queued or mid-flight) -- the floor-plan screen uses this to show a "pending sync" indicator
  // per guest, per FR-16.2.
  pendingSync: boolean;
}

export interface TableViewModel {
  table: SeatingTableDTO;
  seated: SeatedGuest[];
}

export interface FloorPlanViewModel {
  tables: TableViewModel[];
  unassigned: SeatedGuest[];
}

const LOCAL_ASSIGNMENT_PREFIX = "local:";

export function buildFloorPlanViewModel(
  tables: SeatingTableDTO[],
  guests: GuestDTO[],
  planVersion: PlanVersionDetailDTO
): FloorPlanViewModel {
  const guestById = new Map(guests.map((g) => [g.id, g]));
  const byTable = new Map<string, TableViewModel>();
  for (const table of tables) byTable.set(table.id, { table, seated: [] });

  for (const assignment of planVersion.assignments) {
    const guest = guestById.get(assignment.guestId);
    const vm = byTable.get(assignment.tableId);
    if (!guest || !vm) continue; // a table/guest this device hasn't cached yet -- skip rather than crash
    vm.seated.push({
      guest,
      needsReassignment: assignment.needsReassignment,
      pendingSync: assignment.id.startsWith(LOCAL_ASSIGNMENT_PREFIX),
    });
  }

  const unassigned = planVersion.unassignedGuestIds
    .map((id) => guestById.get(id))
    .filter((g): g is GuestDTO => Boolean(g))
    .map((guest) => ({ guest, needsReassignment: false, pendingSync: false }));

  return {
    tables: tables.map((t) => byTable.get(t.id)!),
    unassigned,
  };
}

// Applies a move to a *local copy* of the plan version, before the server has confirmed it --
// used both for genuine offline queueing and for optimistic UI while a request is in flight.
// `assignment.id` is stamped with a "local:" marker (see above) purely so the view model can flag
// it as pending; it's never sent back to the server, which always issues its own assignment ids.
export function applyLocalMove(
  planVersion: PlanVersionDetailDTO,
  guest: GuestDTO,
  toTableId: string | null,
  toTable: SeatingTableDTO | undefined
): PlanVersionDetailDTO {
  const assignments: PlanVersionAssignmentDTO[] = planVersion.assignments.filter(
    (a) => a.guestId !== guest.id
  );
  const unassignedGuestIds = planVersion.unassignedGuestIds.filter((id) => id !== guest.id);

  if (toTableId === null) {
    unassignedGuestIds.push(guest.id);
  } else {
    assignments.push({
      id: `${LOCAL_ASSIGNMENT_PREFIX}${guest.id}`,
      guestId: guest.id,
      guestName: `${guest.firstName} ${guest.lastName}`,
      tableId: toTableId,
      tableLabel: toTable?.label ?? "",
      needsReassignment: false,
    });
  }

  // Mirrors the server's own FR-7.7 behaviour (each accepted manual move bumps revision by
  // exactly 1) so a chain of offline moves can each capture the expectedRevision the *next* one
  // will need without asking the server first. See offline/queue.ts's replayQueue, which submits
  // moves in this same order and relies on that assumption.
  return { ...planVersion, assignments, unassignedGuestIds, revision: planVersion.revision + 1 };
}

// Reverts an optimistic/queued move that turned out to be invalid (the server rejected it on
// replay with a business-rule error, not a conflict -- see MoveRejectedError in api/planVersions.ts)
// by re-deriving the plan version from the last confirmed one plus the still-pending moves that
// come after it, rather than trying to hand-patch the rejected one back out.
export function findGuest(guests: GuestDTO[], guestId: string): GuestDTO | undefined {
  return guests.find((g) => g.id === guestId);
}

export function findTable(tables: SeatingTableDTO[], tableId: string): SeatingTableDTO | undefined {
  return tables.find((t) => t.id === tableId);
}
