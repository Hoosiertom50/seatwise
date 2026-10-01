/**
 * TS-114 (REQ-BUDGET-VENDOR-TRACKING) — a vendor's private read-only link. The planner shares it
 * from the Budget tab; the vendor opens it with no account and sees the wedding's date and venue,
 * the whole day-of timeline, their own details, and the other vendors' names and arrival times
 * (Tom's decisions, 2026-09-29). Never costs, contract notes, the budget, other vendors' contact
 * details, or anything about guests -- checked in both the page and its API response.
 *
 * A timeline change shows the next time the link is opened; "New link" kills the old one; "Turn
 * off link" kills it outright; a made-up link reads as inactive; and a View collaborator can't
 * make one.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { VendorViewPage } from "../pages/VendorViewPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

const PRIVATE_STRINGS = ["1,500", "1500", "900", "20,000", "SECRET-TERMS", "dj-private@example.invalid", "Secret guest note"];

defineQualityTest(
  {
    id: "budget.vendor-read-only-link-shows-the-day-and-nothing-private.share-view-update-regenerate-revoke-view-only",
    title: "a vendor's read-only link shows the timeline, their details and other vendors' arrival times with nothing private, stays current, and can be replaced or turned off",
    objective:
      "Confirms that Share link on the Budget tab produces a link that opens with no account and shows the wedding name, the whole timeline, the vendor's own contact details and arrival time, and the other vendors' names and arrival times; that no cost, contract note, budget figure, other vendor's contact detail, guest name or guest note appears on the page or in its API response; that a timeline entry added afterwards shows on the next open; that New link makes the old link inactive; that Turn off link makes the link inactive; that a made-up link is inactive; and that a View collaborator gets no Share link button and is refused by the API.",
    expectedOutcome:
      "The page shows the wedding name, 'Bloom & Co' with '2:30 PM' and its contact details, both timeline entries, and 'DJ Spin' with 'Arrives 5:00 PM'. None of the private strings or the guest's name appear on the page or in the JSON, which has no costCents or contractNotes. The added 'Last dance' entry shows after reopening. The old link, the turned-off link and a made-up one each show 'This link is no longer active'. The View user sees no Share link button and the API answers 403.",
    requirementIds: ["REQ-BUDGET-VENDOR-TRACKING"],
    tags: ["@mutating", "@feature:budget", "@feature:timeline", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context, browser }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const budget = new BudgetTabPage(page);
    const guest = uniquePersonName(testInfo.workerIndex);
    await weddingData.createGuest(w, { ...guest, notes: "Secret guest note" });
    await weddingData.createTimelineEntry(w, { time: "16:00", description: "Ceremony" });
    await weddingData.createTimelineEntry(w, { time: "18:30", description: "Dinner service" });

    await budget.goto(w);
    await budget.saveBudget("20000");
    await budget.addVendor({
      name: "Bloom & Co",
      category: "Florist",
      contactName: "Rosa",
      contactEmail: "rosa@example.invalid",
      contactPhone: "555-0100",
      cost: "1500",
      contractNotes: "Deposit SECRET-TERMS",
      arrivalTime: "14:30",
    });
    await budget.addVendor({
      name: "DJ Spin",
      category: "Music / Entertainment",
      contactEmail: "dj-private@example.invalid",
      cost: "900",
      arrivalTime: "17:00",
    });

    const visitor = await browser.newContext();
    const vendorPage = new VendorViewPage(await visitor.newPage());
    try {
      let url = "";
      await test.step("Share link opens with no account and shows the day", async () => {
        url = await budget.getShareLink("Bloom & Co");
        await vendorPage.gotoUrl(url);
        await expect(vendorPage.heading()).toHaveText(managedWedding.name);
        await expect(vendorPage.yourDetails()).toContainText("Bloom & Co");
        await expect(vendorPage.yourDetails()).toContainText("2:30 PM");
        await expect(vendorPage.yourDetails()).toContainText("rosa@example.invalid");
        await expect(vendorPage.timeline()).toContainText("Ceremony");
        await expect(vendorPage.timeline()).toContainText("Dinner service");
        await expect(vendorPage.otherVendors()).toContainText("DJ Spin");
        await expect(vendorPage.otherVendors()).toContainText("Arrives 5:00 PM");
      });

      await test.step("Nothing private on the page or in its API response", async () => {
        // The test wedding's own name starts with "Playwright", like every test guest's first name -- so
        // the guest is checked by full name and last name.
        const guestSecrets = [...PRIVATE_STRINGS, `${guest.firstName} ${guest.lastName}`, guest.lastName];
        const text = await vendorPage.allText();
        for (const secret of guestSecrets) expect(text).not.toContain(secret);

        const token = new URL(url).pathname.split("/").pop()!;
        const raw = await (await visitor.request.get(`/api/v1/vendor-view/${token}`)).text();
        for (const secret of guestSecrets) expect(raw).not.toContain(secret);
        expect(raw).not.toContain("costCents");
        expect(raw).not.toContain("contractNotes");
      });

      await test.step("A timeline change shows the next time the link is opened", async () => {
        await weddingData.createTimelineEntry(w, { time: "22:45", description: "Last dance" });
        await vendorPage.gotoUrl(url);
        await expect(vendorPage.timeline()).toContainText("Last dance");
      });

      await test.step("New link makes the old one inactive; Turn off link makes the new one inactive", async () => {
        const fresh = await budget.getShareLink("Bloom & Co", true);
        expect(fresh).not.toBe(url);
        await vendorPage.gotoUrl(url);
        await expect(vendorPage.inactiveMessage()).toBeVisible();
        await vendorPage.gotoUrl(fresh);
        await expect(vendorPage.yourDetails()).toContainText("Bloom & Co");

        await budget.turnOffShareLink("Bloom & Co");
        await vendorPage.gotoUrl(fresh);
        await expect(vendorPage.inactiveMessage()).toBeVisible();
      });

      await test.step("A made-up link is inactive", async () => {
        await vendorPage.gotoToken("0".repeat(64));
        await expect(vendorPage.inactiveMessage()).toBeVisible();
      });
    } finally {
      await visitor.close();
    }

    await test.step("An arrival time that isn't a clock time is refused", async () => {
      const res = await context.request.post(`/api/v1/weddings/${w}/vendors`, {
        data: { name: "Late Cake", category: "CAKE_BAKERY", arrivalTime: "half past four" },
      });
      expect(res.status()).toBe(422);
      expect(JSON.stringify(await res.json())).toContain("Use a time like 14:30");
    });

    await test.step("A View collaborator can't make a link", async () => {
      const viewer = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "viewer");
      try {
        await weddingData.addCollaborator(w, viewer.email, "VIEW");
        const viewerBudget = new BudgetTabPage(await viewer.context.newPage());
        await viewerBudget.goto(w);
        await expect(viewerBudget.vendorsHeading(2)).toBeVisible();
        await expect(viewerBudget.shareLinkButton("DJ Spin")).toHaveCount(0);
        const vendors = ((await (await context.request.get(`/api/v1/weddings/${w}/vendors`)).json()) as {
          vendors: { id: string; name: string }[];
        }).vendors;
        const dj = vendors.find((v) => v.name === "DJ Spin")!;
        const refused = await viewer.context.request.post(`/api/v1/weddings/${w}/vendors/${dj.id}/share-link`, { data: {} });
        expect(refused.status()).toBe(403);
      } finally {
        await viewer.context.close();
      }
    });
  },
);
