/**
 * TS-195 — changes made at the same moment stay consistent. Each race is made exact from the test,
 * by holding a lock (or an unsaved delete) from outside the app while the requests reach it:
 * - A guest edit that marks them as needing an accessible table takes the current plan's lock
 *   before the guest's own row (the usual order), so it can't deadlock with a list being saved --
 *   while it waits for the plan, the guest's row is still free for other edits.
 * - A planner's edit of a guest's RSVP answer and the guest's own answer by link, sent at the same
 *   moment, never leave the guest Confirmed but Not Attending (or Declined but Attending): the
 *   attendance change is decided inside the edit, from the guest as they are under its lock.
 * - Refusing to bring a guest back to Attending (their Restricted table's list would overflow)
 *   refuses the whole edit: nothing of it is saved.
 * - A wedding handed to someone whose account is being deleted at that moment: the hand-off is
 *   refused in words ("account was just deleted"), nothing changes.
 * - "Reset all links" takes the wedding's lock first.
 * - Something added to a wedding that's being deleted at that moment, and a comment on a guest
 *   being removed at that moment: a clear 404 in words, never a server error.
 * - Two quick-creates (or a quick-create and a template) at the same moment never make two tables
 *   with the same name.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import type { APIRequestContext, Browser } from "@playwright/test";
import { uniquePersonName, uniqueTestAddress, uniqueTitle, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { confirmTestAccountEmail, holdDeletion, holdPlanVersion, holdWeddingLock } from "../support/testDatabase.js";

interface GuestState {
  rsvpStatus: string;
  dayOfAttendance: string;
  requiresAccessibleTable: boolean;
  notes: string | null;
  firstName: string;
}

async function signUp(browser: Browser, workerIndex: number, label: string) {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
  const token = uniqueToken(workerIndex);
  const email = `pw-tester-${label}-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
  const password = `pw-${token}-long-enough`;
  const res = await context.request.post("/api/v1/auth/signup", {
    data: { name: `Playwright Tester ${label} ${token}`, email, password },
  });
  expect(res.ok()).toBe(true);
  await confirmTestAccountEmail(email);
  return { context, email, password, request: context.request as APIRequestContext };
}

defineQualityTest(
  {
    id: "cross-cutting.changes-made-at-the-same-moment-stay-consistent.guest-edits-and-rsvps",
    title: "a guest edit takes its locks in the usual order, a planner's and a guest's own RSVP answer at the same moment leave attendance matching the answer, and a refused bring-back saves nothing",
    objective:
      "Confirms that an edit marking a guest as needing an accessible table waits for the current plan's lock before it locks the guest (another edit of the same guest goes through meanwhile); that when a planner changes a Declined guest to Confirmed and the guest declines again by link at the same moment (both held at the wedding's lock, then let go), the guest ends up with an answer and attendance that agree (Confirmed and Attending, or Declined and Not Attending); and that a planner bringing a guest back from Declined, when their Restricted table's list would then need more seats than it has, is refused with 422 and nothing of the edit is saved.",
    expectedOutcome:
      "Accessible edit: waits on the held plan (1 waiter) while a notes edit of the same guest returns 200; then 200 once released. RSVP race: both 200; final guest (CONFIRMED, ATTENDING) or (DECLINED, NOT_ATTENDING). Refused bring-back: 422 naming the table's list; the guest's rsvpStatus is still DECLINED, dayOfAttendance NOT_ATTENDING, and the first name sent in the same edit was not saved.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, playwright, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guestOf = async (id: string) =>
      ((await (await context.request.get(api(`guests/${id}`))).json()) as { guest: GuestState }).guest;
    const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });

    try {
      await test.step("An accessible-table edit waits for the plan before it locks the guest", async () => {
        const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
        await weddingData.createTable(w, { label: uniqueTitle(testInfo.workerIndex, "Lock Order Table"), capacity: 8 });
        const plan = await weddingData.generatePlanVersion(w);
        const held = await holdPlanVersion(plan.id);
        let editing;
        try {
          editing = context.request.patch(api(`guests/${guest.id}`), { data: { requiresAccessibleTable: true } });
          await held.waitForWaiters(1);
          // The guest's row isn't locked yet -- a plain edit of the same guest goes straight through.
          const notes = await context.request.patch(api(`guests/${guest.id}`), { data: { notes: "Edited while the other waits" } });
          expect(notes.status()).toBe(200);
        } finally {
          await held.release();
        }
        expect((await editing!).status()).toBe(200);
        const after = await guestOf(guest.id);
        expect(after.requiresAccessibleTable).toBe(true);
        expect(after.notes).toBe("Edited while the other waits");
      });

      await test.step("The planner's and the guest's own answer at the same moment leave attendance matching the answer", async () => {
        const guest = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), rsvpStatus: "DECLINED" });
        expect((await guestOf(guest.id)).dayOfAttendance).toBe("NOT_ATTENDING");
        const link = await context.request.post(api(`guests/${guest.id}/rsvp-link`), { data: { regenerate: false } });
        expect(link.ok()).toBe(true);
        const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;

        const held = await holdWeddingLock(w);
        let planner;
        let own;
        try {
          planner = context.request.patch(api(`guests/${guest.id}`), { data: { rsvpStatus: "CONFIRMED" } });
          await held.waitForWaiters(1);
          own = visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "DECLINED" } });
          await held.waitForWaiters(2);
        } finally {
          await held.release();
        }
        const [p, o] = await Promise.all([planner, own]);
        expect(p!.status()).toBe(200);
        expect(o!.status()).toBe(200);
        const after = await guestOf(guest.id);
        expect([
          ["CONFIRMED", "ATTENDING"],
          ["DECLINED", "NOT_ATTENDING"],
        ]).toContainEqual([after.rsvpStatus, after.dayOfAttendance]);
      });

      await test.step("Refusing to bring a guest back refuses the whole edit", async () => {
        const name = uniquePersonName(testInfo.workerIndex);
        const declined = await weddingData.createGuest(w, { ...name, rsvpStatus: "DECLINED", headcount: 2 });
        const other = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), headcount: 2 });
        const table = await weddingData.createTable(w, {
          label: uniqueTitle(testInfo.workerIndex, "Small Restricted"),
          capacity: 3,
          isRestricted: true,
        });
        // Fits while the declined guest doesn't count (2 of 3 seats).
        await weddingData.setRequiredGuests(w, table.id, [declined.id, other.id]);

        const res = await context.request.patch(api(`guests/${declined.id}`), {
          data: { rsvpStatus: "CONFIRMED", firstName: "Renamed" },
        });
        expect(res.status()).toBe(422);
        expect(((await res.json()) as { error: string }).error).toContain("required-guest list");
        const after = await guestOf(declined.id);
        expect(after.rsvpStatus).toBe("DECLINED");
        expect(after.dayOfAttendance).toBe("NOT_ATTENDING");
        expect(after.firstName).toBe(name.firstName);
      });
    } finally {
      await visitor.dispose();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.changes-made-at-the-same-moment-stay-consistent.handoff-while-account-is-deleted",
    title: "handing a wedding to someone whose account is being deleted at that moment is refused in words and changes nothing",
    objective:
      "Confirms that when the account a wedding is being handed to is deleted at that same moment (the delete held unsaved from outside the app), the hand-off waits for the account's row before touching anything, then is refused with 409 saying the account was just deleted; the wedding is still owned by the person handing it off.",
    expectedOutcome:
      "The hand-off waits on the held delete (1 waiter). After the delete is saved: 409 \"That person's account was just deleted — pick someone else to hand this wedding to.\" The owner's GET of the wedding is 200 with accessLevel OWNER.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@feature:collaboration", "@risk:critical", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const owner = await signUp(browser, testInfo.workerIndex, "owner");
    const helper = await signUp(browser, testInfo.workerIndex, "helper");
    let weddingId = "";
    try {
      weddingId = ((await (await owner.request.post("/api/v1/weddings", {
        data: { name: uniqueTitle(testInfo.workerIndex, "Handoff Delete Wedding") },
      })).json()) as { wedding: { id: string } }).wedding.id;
      const added = await owner.request.post(`/api/v1/weddings/${weddingId}/collaborators`, {
        data: { email: helper.email, permissionLevel: "EDIT", role: "COLLABORATOR" },
      });
      expect(added.ok()).toBe(true);
      const collaboratorId = ((await added.json()) as { collaborator: { id: string } }).collaborator.id;

      await test.step("The hand-off waits for the account being deleted, then is refused", async () => {
        const held = await holdDeletion("account", helper.email);
        let handingOff;
        try {
          handingOff = owner.request.post(`/api/v1/weddings/${weddingId}/transfer-ownership`, { data: { collaboratorId } });
          await held.waitForWaiters(1);
          await held.commit();
        } finally {
          await held.release();
        }
        const res = await handingOff!;
        expect(res.status()).toBe(409);
        expect(((await res.json()) as { error: string }).error).toBe(
          "That person's account was just deleted — pick someone else to hand this wedding to.",
        );
      });

      await test.step("Nothing changed: the wedding is still the owner's", async () => {
        const res = await owner.request.get(`/api/v1/weddings/${weddingId}`);
        expect(res.status()).toBe(200);
        expect(((await res.json()) as { accessLevel?: string }).accessLevel).toBe("OWNER");
      });
    } finally {
      if (weddingId) await owner.request.delete(`/api/v1/weddings/${weddingId}`).catch(() => {});
      await owner.context.close();
      await helper.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.changes-made-at-the-same-moment-stay-consistent.links-labels-and-deleted-things",
    title: "resetting links waits for the wedding's lock, two quick-creates at once never repeat a table name, and adding to a wedding (or commenting on a guest) being deleted at that moment is a clear 404",
    objective:
      "Confirms that Reset all links waits for the wedding's lock before touching any link (then succeeds); that two quick-creates with the same prefix sent at the same moment (held at the wedding's lock, then let go) make tables with all-different names; that a comment on a guest who is removed at that moment is refused with 404 saying the guest was removed; and that a guest, a table, a timeline entry, a vendor, a quick-create and a links reset sent while the wedding is being deleted are each answered 404 \"This wedding was deleted\" rather than a server error.",
    expectedOutcome:
      "Reset: 1 waiter on the held wedding lock, then 200. Quick-creates: both 201, 4 distinct labels. Comment: 404 \"That guest was removed a moment ago, so your comment wasn't saved.\" Every request held behind the wedding's delete: 404 \"This wedding was deleted — nothing was saved.\"",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT", "REQ-COLLABORATION-NOTIFICATIONS", "REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:tables", "@feature:collaboration", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;

    await test.step("Reset all links takes the wedding's lock first", async () => {
      const held = await holdWeddingLock(w);
      let resetting;
      try {
        resetting = context.request.post(api("reset-links"), { data: {} });
        await held.waitForWaiters(1);
      } finally {
        await held.release();
      }
      expect((await resetting!).status()).toBe(200);
    });

    await test.step("Two quick-creates at once never repeat a table name", async () => {
      const prefix = uniqueTitle(testInfo.workerIndex, "Race");
      const held = await holdWeddingLock(w);
      let first;
      let second;
      try {
        const body = { count: 2, capacity: 8, shape: "ROUND", labelPrefix: prefix };
        first = context.request.post(api("tables/quick-create"), { data: body });
        second = context.request.post(api("tables/quick-create"), { data: body });
        await held.waitForWaiters(2);
      } finally {
        await held.release();
      }
      const [a, b] = await Promise.all([first, second]);
      expect(a!.status()).toBe(201);
      expect(b!.status()).toBe(201);
      const labels = [
        ...((await a!.json()) as { tables: { label: string }[] }).tables,
        ...((await b!.json()) as { tables: { label: string }[] }).tables,
      ].map((t) => t.label);
      expect(new Set(labels).size).toBe(4);
    });

    await test.step("A comment on a guest removed at that moment is refused in words", async () => {
      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const held = await holdDeletion("guest", guest.id);
      let commenting;
      try {
        commenting = context.request.post(api("comments"), { data: { targetType: "GUEST", guestId: guest.id, body: "Seat near the door?" } });
        await held.waitForWaiters(1);
        await held.commit();
      } finally {
        await held.release();
      }
      const res = await commenting!;
      expect(res.status()).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("That guest was removed a moment ago, so your comment wasn't saved.");
    });

    await test.step("Adding to a wedding being deleted at that moment is a clear 404", async () => {
      const held = await holdDeletion("wedding", w);
      const requests = [];
      try {
        requests.push(
          context.request.post(api("guests"), { data: uniquePersonName(testInfo.workerIndex) }),
          context.request.post(api("tables"), { data: { label: "Late Table", capacity: 8 } }),
          context.request.post(api("timeline-entries"), { data: { time: "16:30", description: "Late entry" } }),
          context.request.post(api("vendors"), { data: { name: "Late Vendor", category: "FLORIST" } }),
          context.request.post(api("tables/quick-create"), { data: { count: 1, capacity: 8, shape: "ROUND", labelPrefix: "Late" } }),
          context.request.post(api("reset-links"), { data: {} }),
        );
        await held.waitForWaiters(requests.length);
        await held.commit();
      } finally {
        await held.release();
      }
      for (const res of await Promise.all(requests)) {
        expect(res.status(), await res.text()).toBe(404);
        expect(((await res.json()) as { error: string }).error).toBe("This wedding was deleted — nothing was saved.");
      }
    });
  },
);
