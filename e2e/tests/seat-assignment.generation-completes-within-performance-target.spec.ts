/**
 * TS-38 (REQ-AUTOMATED-SEAT-ASSIGNMENT) — converts AC-046 ("Generation completes within the
 * performance target at typical scale"), a Performance/Must case the story explicitly says not to
 * skip. Per the workbook's own precondition/expected-result pair, this measures the generation
 * request itself (300 Attending guests, 40 tables, a satisfiable set with no rule conflicts) at
 * under 15 seconds -- not the whole test's wall-clock time, which also includes creating 300
 * guests as this test's own Arrange and is not part of what AC-046 bounds. Calls the
 * `/plan-versions/generate` endpoint directly rather than through the UI, so the measured
 * duration is the engine's own request/response time, uncomplicated by React rendering.
 */

import { defineQualityTest, expect, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

const GUEST_COUNT = 300;
const TABLE_COUNT = 40;
const TABLE_CAPACITY = 8; // 320 seats for 300 guests -- satisfiable with room to spare.
const PERFORMANCE_TARGET_MS = 15_000;

defineQualityTest(
  {
    id: "seat-assignment.generation-completes-within-performance-target.300-guests-40-tables",
    title: "generation for 300 guests and 40 tables completes in under 15 seconds",
    objective:
      "Confirms the seat-assignment engine meets its documented performance target (NFR 9.1) at the workbook's specified scale: 300 Attending guests, 40 active tables, a satisfiable rule set.",
    expectedOutcome:
      "The generation request returns a complete plan, and the elapsed time from request to response is under 15 seconds.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, evidence }, testInfo) => {
    await test.step(`Arrange: create ${GUEST_COUNT} Attending guests and ${TABLE_COUNT} tables (${TABLE_CAPACITY} seats each)`, async () => {
      // Concurrent, but chunked -- 300 simultaneous requests at once against a single local dev
      // server risks connection-pool exhaustion that would only measure this test's own setup
      // noise, not the engine.
      const CHUNK_SIZE = 25;
      for (let i = 0; i < GUEST_COUNT; i += CHUNK_SIZE) {
        const chunk = Array.from({ length: Math.min(CHUNK_SIZE, GUEST_COUNT - i) }, () =>
          weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex)),
        );
        await Promise.all(chunk);
      }
      await weddingData.quickCreateTables(managedWedding.id, { count: TABLE_COUNT, capacity: TABLE_CAPACITY });
    });

    const { elapsedMs, ok, isComplete, unassignedCount } = await test.step("Act: submit one generation request and time it", async () => {
      const start = Date.now();
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      const elapsed = Date.now() - start;
      const body = (await res.json()) as {
        planVersion?: { isComplete: boolean; unassignedGuestIds: string[] };
      };
      return {
        elapsedMs: elapsed,
        ok: res.ok(),
        isComplete: body.planVersion?.isComplete ?? false,
        unassignedCount: body.planVersion?.unassignedGuestIds.length ?? -1,
      };
    });

    await test.step("Assert: the plan is complete and generation finished under the 15-second target", async () => {
      expect(ok).toBe(true);
      expect(isComplete).toBe(true);
      expect(unassignedCount).toBe(0);
      expect(elapsedMs).toBeLessThan(PERFORMANCE_TARGET_MS);
    });

    await evidence.checkpoint(
      "generation-within-performance-target",
      `Generating a complete plan for ${GUEST_COUNT} guests and ${TABLE_COUNT} tables took ${elapsedMs}ms (target: under ${PERFORMANCE_TARGET_MS}ms).`,
    );
  },
);
