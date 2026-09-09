import type { GuestDTO, PlanVersionDetailDTO, SeatingTableDTO } from "@seatwise/shared";

// Minimal, fully-typed builders for the two DTOs this app merges/mutates locally -- only the
// fields a given test cares about need overriding, everything else gets a harmless default so
// these fixtures don't have to be retyped in full at every call site.
export function makeGuest(overrides: Partial<GuestDTO> & { id: string }): GuestDTO {
  return {
    weddingId: "wedding-1",
    firstName: "First",
    lastName: "Last",
    partyName: null,
    headcount: 1,
    tier: "OTHER",
    rsvpStatus: "CONFIRMED",
    requiresAccessibleTable: false,
    isLocked: false,
    dayOfAttendance: "ATTENDING",
    notes: null,
    side: "BOTH",
    ageCategory: "ADULT",
    requiredTableId: null,
    email: null,
    plusOneNames: null,
    rsvpRespondedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    ...overrides,
  };
}

export function makeTable(overrides: Partial<SeatingTableDTO> & { id: string }): SeatingTableDTO {
  return {
    weddingId: "wedding-1",
    label: "Table",
    capacity: 8,
    isRestricted: false,
    isAccessible: false,
    isLocked: false,
    purpose: null,
    purposeCriterionType: null,
    purposeCriterionValue: null,
    singleSideOnly: false,
    shape: "ROUND",
    positionX: null,
    positionY: null,
    requiredGuestIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    ...overrides,
  };
}

export function makePlanVersion(
  overrides: Partial<PlanVersionDetailDTO> = {}
): PlanVersionDetailDTO {
  return {
    id: "plan-1",
    weddingId: "wedding-1",
    versionNumber: 1,
    label: null,
    status: "DRAFT",
    isComplete: false,
    approvedAt: null,
    isCurrent: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    assignedGuestCount: 0,
    unassignedGuestCount: 0,
    restoredFromVersionNumber: null,
    sideMixingSetting: null,
    ruleConfigVersion: null,
    revision: 0,
    assignments: [],
    unassignedGuestIds: [],
    warnings: [],
    modifiedSinceApproval: { active: false, firstModifiedAt: null, latestModifiedAt: null },
    ...overrides,
  };
}
