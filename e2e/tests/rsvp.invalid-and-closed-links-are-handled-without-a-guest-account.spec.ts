/**
 * TS-50 (REQ-CLIENT-RSVP-COLLECTION) — the edge-case half of FR-12.1/FR-12.2, complementing
 * `rsvp.guest-can-submit-and-update-their-own-rsvp-through-the-link.spec.ts`'s happy path. All
 * three scenarios here are checked at the API level (a bare, cookie-free
 * `request.newContext()` -- no browser needed, since these are status/error-shape assertions, not
 * UI behavior) plus one direct UI check that the closed-form banner and disabled fields actually
 * render, confirmed directly against apps/web/src/app/api/v1/rsvp/[token]/route.ts and
 * packages/db/src/queries/guests.ts's `submitGuestRsvp`/`RsvpSubmissionError`.
 *
 * FR-12.2's cutoff check (`isPastCutoff`, duplicated identically in both the route and the query
 * function, "kept in sync" per their own comments) treats `rsvpCutoffDate` as a whole calendar
 * day, not a timestamp: responses are accepted through 23:59:59 of the cutoff date itself and only
 * actually close at the start of the next day -- this test picks a cutoff several days in the
 * past specifically to avoid any timezone-boundary ambiguity around "today."
 */

import { request as playwrightRequest } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { GuestRsvpPage } from "../pages/GuestRsvpPage.js";
import { getEnv } from "../support/env.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "rsvp.invalid-and-closed-links-are-handled-without-a-guest-account.unknown-closed-and-invalid-submissions",
    title: "an unknown RSVP token is reported as not found (never a bare error), a token past the wedding's cutoff shows the guest's current answers read-only and refuses further submissions, and an out-of-range submission is rejected with a 422",
    objective:
      "Confirms GET on an unknown token returns 200 with status NOT_FOUND (not an HTTP error) and POST returns 404 'This RSVP link isn't valid.'; that a token whose wedding has a past rsvpCutoffDate returns status CLOSED with the guest's on-file answers still shown, renders as a disabled form with the closed banner in the real UI, and returns 409 'RSVP responses have closed for this wedding.' on POST; and that an out-of-range headcount is rejected with a 422 'Validation failed' before ever reaching the guest record.",
    expectedOutcome:
      "Unknown token: GET 200 {status: NOT_FOUND}, POST 404. Past-cutoff token: GET 200 {status: CLOSED, ...current answers...}, the real page shows the closed banner with a disabled form, and POST returns 409. Out-of-range headcount: POST 422 with fieldErrors.",
    requirementIds: ["REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:rsvp", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    const baseURL = getEnv().APP_URL;
    const anonymousRequest = await playwrightRequest.newContext({ baseURL });

    try {
      await test.step("Assert: an unknown (well-formed but never-issued) token is NOT_FOUND on GET and 404 on POST, never a bare error either way", async () => {
        const unknownToken = "0".repeat(64);

        const getRes = await anonymousRequest.get(`/api/v1/rsvp/${unknownToken}`);
        expect(getRes.status()).toBe(200);
        const getBody = (await getRes.json()) as { rsvp: { status: string } };
        expect(getBody.rsvp.status).toBe("NOT_FOUND");

        const postRes = await anonymousRequest.post(`/api/v1/rsvp/${unknownToken}`, {
          data: { rsvpStatus: "CONFIRMED", headcount: 1 },
        });
        expect(postRes.status()).toBe(404);
        const postBody = (await postRes.json()) as { error: string };
        expect(postBody.error).toBe("This RSVP link isn't valid.");
      });

      let closedToken = "";
      const closedCutoffDate = "2026-09-05"; // several days before "today" (2026-09-15), well past any timezone ambiguity

      await test.step("Arrange: a guest whose wedding's RSVP cutoff has already passed", async () => {
        const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
        const patchRes = await context.request.patch(`/api/v1/weddings/${managedWedding.id}`, {
          data: { rsvpCutoffDate: closedCutoffDate },
        });
        expect(patchRes.status()).toBe(200);

        const linkRes = await context.request.post(
          `/api/v1/weddings/${managedWedding.id}/guests/${guest.id}/rsvp-link`,
          { data: {} },
        );
        const linkBody = (await linkRes.json()) as { rsvp: { url: string } };
        closedToken = linkBody.rsvp.url.split("/").pop()!;
      });

      await test.step("Assert: GET on the past-cutoff token reports CLOSED with the guest's current (still-Pending) answers, and POST is refused with a 409", async () => {
        const getRes = await anonymousRequest.get(`/api/v1/rsvp/${closedToken}`);
        expect(getRes.status()).toBe(200);
        const getBody = (await getRes.json()) as {
          rsvp: { status: string; rsvpCutoffDate: string | null; rsvpStatus: string; headcount: number };
        };
        expect(getBody.rsvp.status).toBe("CLOSED");
        expect(getBody.rsvp.rsvpCutoffDate).toBe(closedCutoffDate);
        expect(getBody.rsvp.rsvpStatus).toBe("PENDING");
        expect(getBody.rsvp.headcount).toBe(1);

        const postRes = await anonymousRequest.post(`/api/v1/rsvp/${closedToken}`, {
          data: { rsvpStatus: "CONFIRMED", headcount: 1 },
        });
        expect(postRes.status()).toBe(409);
        const postBody = (await postRes.json()) as { error: string };
        expect(postBody.error).toBe("RSVP responses have closed for this wedding.");
      });

      const guestBrowserContext = await browser.newContext();
      try {
        await test.step("Assert (real UI): the closed link renders the disabled-form banner rather than a normal editable form", async () => {
          const guestPage = await guestBrowserContext.newPage();
          const rsvpPage = new GuestRsvpPage(guestPage);
          await rsvpPage.goto(closedToken);
          await expect(rsvpPage.closedMessage()).toBeVisible();
          await expect(rsvpPage.closedMessage()).toContainText(closedCutoffDate);
          expect(await rsvpPage.isFormDisabled()).toBe(true);
          await guestPage.close();
        });
      } finally {
        await guestBrowserContext.close();
      }

      await test.step("Assert: an out-of-range headcount is rejected with a 422 before ever reaching the guest record", async () => {
        const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
        const linkRes = await context.request.post(
          `/api/v1/weddings/${managedWedding.id}/guests/${guest.id}/rsvp-link`,
          { data: {} },
        );
        const linkBody = (await linkRes.json()) as { rsvp: { url: string } };
        const openToken = linkBody.rsvp.url.split("/").pop()!;

        const res = await anonymousRequest.post(`/api/v1/rsvp/${openToken}`, {
          data: { rsvpStatus: "CONFIRMED", headcount: 21 },
        });
        expect(res.status()).toBe(422);
        const body = (await res.json()) as { error: string; fieldErrors: Record<string, string[]> };
        expect(body.error).toBe("Validation failed");
        expect(body.fieldErrors.headcount).toBeTruthy();
      });
    } finally {
      await anonymousRequest.dispose();
    }
  },
);
