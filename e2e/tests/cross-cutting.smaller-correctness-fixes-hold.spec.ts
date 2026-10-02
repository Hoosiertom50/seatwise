/**
 * TS-153 (REQ-NON-FUNCTIONAL) — smaller correctness fixes from the 2026-10-02 review.
 * - A timeline entry moved to another time goes last there, and can still be reordered.
 * - Quick-create numbers after the highest existing number, never repeating a label.
 * - The budget total handles many large vendor costs (it used to overflow and error).
 * - Two sign-ups for the same email at once: one account, a clear 409 for the other.
 * - Two requests for a guest's RSVP link at once both get the same link.
 * - Two moves into a table's last seat at once never leave it over capacity unflagged.
 * - Asking for a new password-reset link cancels the older one once it's been sent.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle, uniqueToken } from "../data/ids.js";
import { plantPasswordResetToken, usableResetTokenCount } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "cross-cutting.smaller-correctness-fixes-hold.timeline-tables-budget-signup-links-moves-reset",
    title: "timeline reordering, quick-create labels, large budgets, simultaneous sign-ups, RSVP links and moves, and reset links all behave correctly",
    objective:
      "Confirms that an entry moved to another entry's time can be reordered above it; that quick-creating after a deletion never repeats a label; that 25 vendors at the maximum cost give a correct budget total; that two simultaneous sign-ups for one email produce one 201 and one 409; that two simultaneous RSVP-link requests return the same link; that two simultaneous moves into a table's last seat leave at most its capacity seated unflagged; and that a newly sent reset link cancels the older one.",
    expectedOutcome:
      "Timeline order is [B, A] after reordering up, with distinct positions. Quick-create gives Table 6-8 with no duplicate labels. Budget total is 2,500,000,000 cents. Sign-up statuses are {201, 409}. Both RSVP links match. The table's unflagged seated headcount is at most its capacity (3). One usable reset link remains.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:timeline", "@feature:tables", "@feature:budget", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ weddingData, context, playwright, baseURL }, testInfo) => {
    test.setTimeout(90_000);
    const api = (path: string) => `/api/v1/weddings/${path}`;
    const newWedding = async (label: string) => (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, label))).id;

    await test.step("An entry moved to another entry's time goes last there and can be reordered", async () => {
      const w = await newWedding("Timeline");
      const a = (await weddingData.createTimelineEntry(w, { time: "16:00", description: "Ceremony" })).body.entry!;
      const b = (await weddingData.createTimelineEntry(w, { time: "17:00", description: "Photos" })).body.entry!;
      const moved = await context.request.patch(api(`${w}/timeline-entries/${b.id}`), { data: { time: "16:00" } });
      expect(moved.ok()).toBe(true);
      let entries = await weddingData.getTimelineEntries(w);
      expect(entries.map((e) => e.description)).toEqual(["Ceremony", "Photos"]);
      const up = await weddingData.reorderTimelineEntry(w, b.id, "UP");
      expect(up.status).toBe(200);
      entries = await weddingData.getTimelineEntries(w);
      expect(entries.map((e) => e.description)).toEqual(["Photos", "Ceremony"]);
      expect(new Set(entries.map((e) => e.sortOrder)).size).toBe(2);
      expect(a.id).toBeTruthy();
    });

    await test.step("Quick-create never repeats a label after a table is deleted", async () => {
      const w = await newWedding("Quick Create");
      const first = await weddingData.quickCreateTables(w, { count: 5, capacity: 8 });
      const second = first.find((t) => t.label === "Table 2")!;
      expect((await context.request.delete(api(`${w}/tables/${second.id}`))).ok()).toBe(true);
      const more = await weddingData.quickCreateTables(w, { count: 3, capacity: 8 });
      expect(more.map((t) => t.label)).toEqual(["Table 6", "Table 7", "Table 8"]);
      const labels = (await weddingData.listTables(w)).map((t) => t.label);
      expect(new Set(labels).size).toBe(labels.length);
    });

    await test.step("The budget total handles many large vendor costs", async () => {
      const w = await newWedding("Big Budget");
      for (let i = 1; i <= 25; i++) {
        const res = await context.request.post(api(`${w}/vendors`), {
          data: { name: `Vendor ${i}`, category: "OTHER", categoryOther: "Luxury", costCents: 100_000_000 },
        });
        expect(res.status(), `vendor ${i}`).toBe(201);
      }
      const res = await context.request.get(api(`${w}/budget`));
      expect(res.status()).toBe(200);
      const { summary } = (await res.json()) as { summary: { totalCostCents: number } };
      expect(summary.totalCostCents).toBe(2_500_000_000);
    });

    await test.step("Two sign-ups for one email at once: one account, and a clear 409", async () => {
      const email = `pw-tester-race-${uniqueToken(testInfo.workerIndex)}@example.invalid`;
      const signUp = async () => {
        const c = await playwright.request.newContext({ baseURL });
        try {
          return (await c.post("/api/v1/auth/signup", {
            data: { name: "Playwright Tester Race", email, password: randomBytes(12).toString("hex") },
          })).status();
        } finally {
          await c.dispose();
        }
      };
      const statuses = await Promise.all([signUp(), signUp()]);
      expect(statuses.sort()).toEqual([201, 409]);
    });

    const w = await newWedding("Links And Moves");

    await test.step("Two requests for a guest's RSVP link at once both get the same link", async () => {
      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const [one, two] = await Promise.all(
        [0, 1].map(async () =>
          ((await (await context.request.post(api(`${w}/guests/${guest.id}/rsvp-link`), { data: {} })).json()) as { rsvp: { url: string } }).rsvp.url,
        ),
      );
      expect(one).toBe(two);
    });

    await test.step("Two moves into a table's last seat at once never leave it over capacity unflagged", async () => {
      // The RSVP step's guest and "seated" take two seats, leaving one.
      const table = await weddingData.createTable(w, { label: "Three Seats", capacity: 3 });
      const seated = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const plan = await weddingData.generatePlanVersion(w);
      await weddingData.moveGuestAssignment(w, plan.id, seated.id, table.id);
      const x = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const y = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      await Promise.all([
        weddingData.moveGuestAssignment(w, plan.id, x.id, table.id),
        weddingData.moveGuestAssignment(w, plan.id, y.id, table.id),
      ]);
      const detail = await weddingData.getPlanVersionDetail(w, plan.id);
      const okHere = detail.assignments.filter((a) => a.tableId === table.id && !a.needsReassignment);
      expect(okHere.length).toBeLessThanOrEqual(3);
      expect(detail.assignments.filter((a) => a.tableId === table.id).length).toBeGreaterThanOrEqual(2);
    });

    await test.step("A newly sent reset link cancels the older one", async () => {
      const { email } = (await (await context.request.get("/api/v1/auth/me")).json()).user as { email: string };
      await plantPasswordResetToken(email);
      expect(await usableResetTokenCount(email)).toBe(1);
      const res = await context.request.post("/api/v1/auth/forgot-password", { data: { email } });
      expect(res.ok()).toBe(true);
      expect(await usableResetTokenCount(email)).toBe(1);
    });
  },
);
