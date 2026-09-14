/**
 * Stage 03 — project-specific test-data setup/cleanup interface (spec Stage 03 task: "Implement
 * project-specific data setup/cleanup interfaces with explicit no-op or unsupported states").
 *
 * Creates and tears down real records through the app's own REST API (never direct SQL), reusing
 * the calling `APIRequestContext`'s cookie jar -- so this must be called with a request context
 * that has already authenticated (see e2e/support/auth.ts), never with embedded credentials of
 * its own.
 */

import type { APIRequestContext } from "@playwright/test";

export class UnsupportedCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCleanupError";
  }
}

export interface CreatedWedding {
  id: string;
  name: string;
}

export interface CreatedGuest {
  id: string;
  firstName: string;
  lastName: string;
}

export interface CreateGuestInput {
  firstName: string;
  lastName: string;
  email?: string;
  // TS-38: the seat-assignment engine's own inputs -- optional because most callers (guest
  // list/RSVP tests) only need a plain attending guest, but the engine tests need to set these
  // explicitly rather than rely on the API's own defaults (ATTENDING/false/false) to build a
  // specific scenario (a Not Attending guest, a guest requiring an accessible table, a guest
  // created already locked).
  dayOfAttendance?: "ATTENDING" | "NOT_ATTENDING";
  requiresAccessibleTable?: boolean;
  isLocked?: boolean;
}

export interface CreatedTable {
  id: string;
  label: string;
  capacity: number;
}

// TS-54: a single table with the specific flags the cross-cutting hard-rule tests need
// (isRestricted, isAccessible) -- the quick-create endpoint below only makes plain identical
// tables, with no way to set either flag.
export interface CreateTableInput {
  label: string;
  capacity: number;
  isRestricted?: boolean;
  isAccessible?: boolean;
}

export interface CreatedTableDetail extends CreatedTable {
  isRestricted: boolean;
  isAccessible: boolean;
}

export interface QuickCreateTablesInput {
  count: number;
  capacity: number;
  shape?: "ROUND" | "RECTANGULAR" | "SQUARE" | "OVAL" | "OTHER";
  labelPrefix?: string;
}

export type RelationshipType = "MUST_SIT_TOGETHER" | "MUST_NOT_SIT_TOGETHER" | "PREFER_NEAR" | "AVOID";

async function assertOk(res: { ok(): boolean; status(): number; text(): Promise<string> }, action: string) {
  if (!res.ok()) {
    throw new Error(`${action} failed: HTTP ${res.status()} — ${await res.text()}`);
  }
}

export class WeddingDataSetup {
  constructor(private readonly request: APIRequestContext) {}

  async createWedding(name: string): Promise<CreatedWedding> {
    const res = await this.request.post("/api/v1/weddings", { data: { name } });
    await assertOk(res, `createWedding("${name}")`);
    const body = (await res.json()) as { wedding: { id: string; name: string } };
    return { id: body.wedding.id, name: body.wedding.name };
  }

  async createGuest(weddingId: string, input: CreateGuestInput): Promise<CreatedGuest> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/guests`, { data: input });
    await assertOk(res, `createGuest("${input.firstName} ${input.lastName}")`);
    const body = (await res.json()) as {
      guest: { id: string; firstName: string; lastName: string };
    };
    return body.guest;
  }

  /** TS-38: creates a batch of identical tables in one call, via the same "12 round tables of 8"
   * quick-create endpoint the Tables tab's own UI uses (`POST .../tables/quick-create`). */
  async quickCreateTables(weddingId: string, input: QuickCreateTablesInput): Promise<CreatedTable[]> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/tables/quick-create`, { data: input });
    await assertOk(res, `quickCreateTables(${JSON.stringify(input)})`);
    const body = (await res.json()) as { tables: CreatedTable[] };
    return body.tables;
  }

  /** TS-54: creates one table with specific flags (isRestricted/isAccessible), via the plain
   * table-creation endpoint (POST .../tables) rather than the identical-batch quick-create one. */
  async createTable(weddingId: string, input: CreateTableInput): Promise<CreatedTableDetail> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/tables`, { data: input });
    await assertOk(res, `createTable("${input.label}")`);
    const body = (await res.json()) as { table: CreatedTableDetail };
    return body.table;
  }

  /** TS-54: replaces a Restricted table's entire required-guest list (PUT .../required-guests) --
   * the only hard-rule fixture setup a manual-move test needs beyond a plain guest/table/rule. */
  async setRequiredGuests(weddingId: string, tableId: string, guestIds: string[]): Promise<void> {
    const res = await this.request.put(`/api/v1/weddings/${weddingId}/tables/${tableId}/required-guests`, {
      data: { guestIds },
    });
    await assertOk(res, `setRequiredGuests(${tableId}, [${guestIds.join(", ")}])`);
  }

  /** TS-38: creates a seating rule between two guests (must/must-not sit together, prefer near,
   * avoid) -- the seat-assignment engine's own rule input. */
  async createRelationship(
    weddingId: string,
    guestAId: string,
    guestBId: string,
    type: RelationshipType,
  ): Promise<{ id: string }> {
    const res = await this.request.post(`/api/v1/weddings/${weddingId}/relationships`, {
      data: { guestAId, guestBId, type },
    });
    await assertOk(res, `createRelationship(${guestAId}, ${guestBId}, ${type})`);
    const body = (await res.json()) as { relationship: { id: string } };
    return body.relationship;
  }

  /** Deletes a single guest. Supported by the app's API (DELETE
   * /api/v1/weddings/:weddingId/guests/:guestId) — included for completeness, though
   * `deleteWedding` alone is enough to clean up everything a test created under it. */
  async deleteGuest(weddingId: string, guestId: string): Promise<void> {
    const res = await this.request.delete(`/api/v1/weddings/${weddingId}/guests/${guestId}`);
    if (!res.ok() && res.status() !== 404) {
      await assertOk(res, `deleteGuest(${guestId})`);
    }
  }

  /** Deletes a wedding and (per the app's own cascade) everything created under it — tables,
   * guests, rules, plan versions. A 404 is treated as already-clean, not a failure. */
  async deleteWedding(weddingId: string): Promise<void> {
    const res = await this.request.delete(`/api/v1/weddings/${weddingId}`);
    if (!res.ok() && res.status() !== 404) {
      await assertOk(res, `deleteWedding(${weddingId})`);
    }
  }

  /**
   * Explicit unsupported state (spec Stage 03 task, verbatim): the app exposes no endpoint to
   * delete a user account (checked directly against the API route tree — there is no
   * `/api/v1/users` or account-deletion route of any kind as of Stage 03). Every account this
   * framework's auth fixture signs up therefore persists in the target database indefinitely;
   * this method exists so that fact is a loud, documented limitation instead of a silent no-op a
   * future maintainer has to rediscover by noticing the user table keeps growing.
   */
  async deleteUserAccount(): Promise<never> {
    throw new UnsupportedCleanupError(
      "The application has no account-deletion endpoint. Test-created user accounts are not " +
        "cleaned up and will accumulate in the target database — see DEC-012 in " +
        "PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md.",
    );
  }
}
