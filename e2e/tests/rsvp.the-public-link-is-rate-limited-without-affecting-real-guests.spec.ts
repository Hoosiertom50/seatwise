/**
 * TS-98 (REQ-CLIENT-RSVP-COLLECTION, REQ-NON-FUNCTIONAL) — the guest RSVP link is the one part of
 * the API anyone can call without signing in, so it is rate-limited (apps/web/src/lib/rate-limit.ts):
 * per network address across every RSVP request, and per guest link across submissions. Limits
 * are counted in Postgres so they hold on any host.
 *
 * Each part of this test uses its own made-up network address (x-forwarded-for, from the
 * 203.0.113.0/24 documentation range) so it neither trips nor is tripped by any other test, and
 * proves one address or link being limited never affects another. Limits are read from the app's
 * own constants' documented values: 100 requests / 10 min per address, 10 submits / 10 min per link.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { GuestRsvpPage } from "../pages/GuestRsvpPage.js";
import { uniquePersonName } from "../data/ids.js";

const PER_ADDRESS_LIMIT = 100;
const SUBMITS_PER_LINK_LIMIT = 10;

function uniqueAddress(): string {
  return `203.0.113.${Math.floor(Math.random() * 254) + 1}-${Date.now()}`;
}

defineQualityTest(
  {
    id: "rsvp.the-public-link-is-rate-limited-without-affecting-real-guests.per-link-per-address-and-page-message",
    title: "the public RSVP link refuses excessive submits per link and excessive requests per address with a 429, without affecting other links or addresses, and the page says to wait",
    objective:
      "Confirms the unauthenticated RSVP endpoint allows normal use, refuses the 11th submit on one link within the window and the 101st request from one address, keeps other links and addresses unaffected, sends Retry-After, and that the RSVP page shows a wait-and-retry message rather than calling the link invalid.",
    expectedOutcome:
      "Submits 1–10 on a link succeed and the 11th returns 429 with Retry-After while another guest's link still accepts a submit; requests 1–100 from an address succeed, the 101st returns 429, and another address is unaffected; the page opened from a limited address shows 'Too many attempts…' and never 'This RSVP link doesn't exist'.",
    requirementIds: ["REQ-CLIENT-RSVP-COLLECTION", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser, playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const linkFor = async () => {
      const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/guests/${guest.id}/rsvp-link`, { data: {} });
      return ((await res.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
    };
    const submit = { rsvpStatus: "CONFIRMED", headcount: 1 };

    await test.step("Per link: 10 submits succeed, the 11th is refused with Retry-After, and another link is unaffected", async () => {
      const token = await linkFor();
      const other = await linkFor();
      const guest = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueAddress() } });
      try {
        for (let i = 1; i <= SUBMITS_PER_LINK_LIMIT; i++) {
          expect((await guest.post(`/api/v1/rsvp/${token}`, { data: submit })).status(), `submit ${i}`).toBe(200);
        }
        const refused = await guest.post(`/api/v1/rsvp/${token}`, { data: submit });
        expect(refused.status()).toBe(429);
        expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
        expect((await guest.post(`/api/v1/rsvp/${other}`, { data: submit })).status()).toBe(200);
      } finally {
        await guest.dispose();
      }
    });

    const limitedAddress = uniqueAddress();
    let token = "";
    await test.step("Per address: 100 requests succeed, the 101st is refused, and another address is unaffected", async () => {
      token = await linkFor();
      const flooding = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": limitedAddress } });
      const someoneElse = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueAddress() } });
      try {
        for (let i = 1; i <= PER_ADDRESS_LIMIT; i++) {
          expect((await flooding.get(`/api/v1/rsvp/${token}`)).status(), `request ${i}`).toBe(200);
        }
        expect((await flooding.get(`/api/v1/rsvp/${token}`)).status()).toBe(429);
        expect((await someoneElse.get(`/api/v1/rsvp/${token}`)).status()).toBe(200);
      } finally {
        await flooding.dispose();
        await someoneElse.dispose();
      }
    });

    await test.step("Page: opened from the limited address, it says to wait -- never that the link doesn't exist", async () => {
      const guestContext = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": limitedAddress } });
      try {
        const rsvpPage = new GuestRsvpPage(await guestContext.newPage());
        await rsvpPage.goto(token);
        await expect(rsvpPage.pageText(/Too many attempts from here/)).toBeVisible();
        await expect(rsvpPage.pageText("This RSVP link doesn't exist.")).toHaveCount(0);
      } finally {
        await guestContext.close();
      }
    });
  },
);
