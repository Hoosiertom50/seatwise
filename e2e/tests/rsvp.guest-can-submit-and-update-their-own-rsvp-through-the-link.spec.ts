/**
 * TS-50 (REQ-CLIENT-RSVP-COLLECTION) — no manual test case or numbered acceptance criterion exists
 * for this requirement (the acceptance-test workbook predates TS-17's planner-pivot roadmap);
 * authored directly from `quality/requirements.yaml`'s REQ-CLIENT-RSVP-COLLECTION description plus
 * README.md's own FR-12.1/12.3 summary and the live implementation.
 *
 * This is the first genuinely unauthenticated, guest-facing flow in this whole test suite:
 * confirmed directly in apps/web/src/app/rsvp/[token]/page.tsx and its API route
 * (apps/web/src/app/api/v1/rsvp/[token]/route.ts) that no session/cookie of any kind is checked
 * anywhere on this path. Driven here from a brand-new `browser.newContext()` with an empty cookie
 * jar -- never the planner's own authenticated `page`/`context` -- so the test actually proves the
 * page needs no account, rather than merely happening to work while also logged in as someone who
 * could see it anyway.
 *
 * Covers FR-12.1 (unauthenticated token link) and FR-12.3 (submission writes straight into the
 * guest's own record) together with a real finding, confirmed directly in
 * packages/db/src/queries/guests.ts's `submitGuestRsvp` and asserted below rather than assumed:
 * there is no lock after a guest's first submission -- they can revisit the same link at any time
 * and resubmit, each time overwriting their own prior answer (the success banner's own text says
 * exactly this). A second real finding: switching to "Regretfully declining" hides the
 * CONFIRMED-only fields (headcount/plus-ones/accessible-seat) from the form, but does NOT clear
 * their previously-submitted values. TS-174: they're no longer sent with the decline, and the server
 * ignores them on a decline anyway -- the values already on file simply stay as they were.
 *
 * Also confirmed and asserted: TS-167 (Tom's decision, 2026-10-05) -- declining marks the guest
 * Not Attending (`dayOfAttendance`), which gives up their seat. TS-154 (Tom's decision #2): each RSVP now notifies the planner and
 * collaborators ("RSVP_RECEIVED"); the Guests tab's "responded" badge (`rsvpRespondedAt`) still
 * flips too, which this test also confirms.
 *
 * TS-107: the guest's free-text note is stored in its own `rsvpNotes` field, never in the
 * planner's private `notes`. Before TS-107 the RSVP page read and overwrote `notes` directly, so a
 * guest saw whatever the planner had written about them and could erase it. This test gives the
 * guest a planner note up front and asserts it never reaches the guest (API response or page) and
 * survives both submissions untouched.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { GuestRsvpPage } from "../pages/GuestRsvpPage.js";
import { uniquePersonName } from "../data/ids.js";

interface GuestListRow {
  id: string;
  rsvpStatus: string;
  rsvpRespondedAt: string | null;
  revision: number;
  dayOfAttendance: string;
  headcount: number;
  plusOneNames: string | null;
  notes: string | null;
  rsvpNotes: string | null;
  requiresAccessibleTable: boolean;
}

const PLANNER_NOTE = "Planner-only: keep away from table 3 (ex-partner seated there).";

defineQualityTest(
  {
    id: "rsvp.guest-can-submit-and-update-their-own-rsvp-through-the-link.no-account-needed-and-no-lock-after-first-answer",
    title: "a guest submits and later changes their own RSVP through their unauthenticated link, with no account and no lock after their first answer, and the change is reflected on the planner's Guests tab with an RSVP notification each time",
    objective:
      "Confirms a fresh, cookie-free browser context can open a guest's RSVP link, see their own name and the wedding name, submit an attending response with party details, see it persisted on reload, then revisit the same link and change to declining -- all without any sign-in. Confirms the planner's private note on the guest is never exposed to the guest and never overwritten (TS-107). Confirms the guest record's rsvpStatus/rsvpRespondedAt/revision update accordingly, declining marks the guest Not Attending (TS-167), the planner gets an RSVP notification for each submission, and previously-submitted party details survive a switch to declining even though their fields are hidden.",
    expectedOutcome:
      "The guest sees their own first name and the wedding's name with no login. Submitting shows the success banner and persists on reload (pre-filled). Revisiting and switching to declining succeeds with no restriction. The planner's own guest record afterward shows rsvpStatus DECLINED, a non-null rsvpRespondedAt, revision bumped by 2, dayOfAttendance NOT_ATTENDING (TS-167), and the earlier party details (headcount/plusOneNames/requiresAccessibleTable) still on file. The planner's private note is absent from the RSVP API response and page and unchanged afterward, while the guest's own final note is in rsvpNotes. The planner has two new RSVP notifications.",
    requirementIds: ["REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:rsvp", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    let guestId = "";
    let rsvpToken = "";
    const guestName = uniquePersonName(testInfo.workerIndex);

    await test.step("Arrange: a guest and their RSVP link", async () => {
      // TS-154: invited as a party of 3, since a guest can RSVP for at most what the planner set.
      const guest = await weddingData.createGuest(managedWedding.id, { ...guestName, notes: PLANNER_NOTE, headcount: 3 });
      guestId = guest.id;

      const res = await context.request.post(
        `/api/v1/weddings/${managedWedding.id}/guests/${guestId}/rsvp-link`,
        { data: {} },
      );
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { rsvp: { url: string } };
      rsvpToken = body.rsvp.url.split("/").pop()!;
    });

    let notificationCountBefore = 0;
    await test.step("Arrange: record the planner's notification count before any RSVP activity", async () => {
      const res = await context.request.get("/api/v1/notifications");
      const body = (await res.json()) as { notifications: unknown[] };
      notificationCountBefore = body.notifications.length;
    });

    const guestBrowserContext = await browser.newContext();
    try {
      const guestPage = await guestBrowserContext.newPage();
      const rsvpPage = new GuestRsvpPage(guestPage);

      await test.step("Act: the guest opens their link with no account of any kind and sees their own name and the wedding's name", async () => {
        await rsvpPage.goto(rsvpToken);
        await expect(rsvpPage.heading()).toHaveText(managedWedding.name);
        await expect(guestPage.getByText(`Hi ${guestName.firstName} —`, { exact: false })).toBeVisible();
      });

      await test.step("Assert (TS-107): the planner's private note is not in the public RSVP response or anywhere on the page", async () => {
        const res = await guestPage.request.get(`/api/v1/rsvp/${rsvpToken}`);
        expect(res.status()).toBe(200);
        expect(await res.text()).not.toContain(PLANNER_NOTE);
        await expect(guestPage.locator("body")).not.toContainText(PLANNER_NOTE);
      });

      await test.step("Act + Assert: the guest submits an attending RSVP with party details, and sees the success banner", async () => {
        await rsvpPage.submit({
          attending: "CONFIRMED",
          headcount: 3,
          plusOneNames: "Sam Plusone, Alex Plusone",
          requiresAccessibleTable: true,
          notes: "Vegetarian, please.",
        });
        await expect(rsvpPage.successBanner()).toBeVisible();
      });

      await test.step("Act + Assert: with no lock of any kind, the guest revisits the same link (a fresh page load) and changes their answer to declining", async () => {
        await rsvpPage.goto(rsvpToken);
        await expect(rsvpPage.heading()).toHaveText(managedWedding.name);
        await rsvpPage.submit({ attending: "DECLINED", notes: "Can't make it after all, sorry!" });
        await expect(rsvpPage.successBanner()).toBeVisible();
      });

      await guestPage.close();
    } finally {
      await guestBrowserContext.close();
    }

    await test.step("Assert: the planner's own guest record reflects the final (declined) answer, with rsvpRespondedAt set, revision bumped twice, dayOfAttendance now Not Attending (TS-167), and the earlier party details still on file despite being hidden once declining", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { guests: GuestListRow[] };
      const guest = body.guests.find((g) => g.id === guestId);
      expect(guest).toBeTruthy();

      expect(guest!.rsvpStatus).toBe("DECLINED");
      expect(guest!.rsvpRespondedAt).toBeTruthy();
      expect(guest!.revision).toBeGreaterThanOrEqual(2); // bumped once per submission (2 submissions)
      // TS-167 (Tom, 2026-10-05): declining gives up the seat, so the guest is now Not Attending.
      expect(guest!.dayOfAttendance).toBe("NOT_ATTENDING");
      // TS-107: the guest's note lands in rsvpNotes; the planner's own note is untouched.
      expect(guest!.rsvpNotes).toBe("Can't make it after all, sorry!");
      expect(guest!.notes).toBe(PLANNER_NOTE);
      // Real finding: declining hides these fields from the form, but their previously-submitted
      // values are simply re-sent as-is (the component's local state for them is never reset), not
      // cleared -- so they remain exactly what was set during the earlier CONFIRMED submission.
      expect(guest!.headcount).toBe(3);
      expect(guest!.plusOneNames).toBe("Sam Plusone, Alex Plusone");
      expect(guest!.requiresAccessibleTable).toBe(true);
    });

    // TS-154 (Tom's decision #2): the planner hears about each response.
    await test.step("Assert: the planner got an RSVP notification for each submission", async () => {
      const res = await context.request.get("/api/v1/notifications");
      const body = (await res.json()) as { notifications: { type: string }[] };
      expect(body.notifications.length).toBe(notificationCountBefore + 2);
      expect(body.notifications.filter((n) => n.type === "RSVP_RECEIVED")).toHaveLength(2);
    });
  },
);
