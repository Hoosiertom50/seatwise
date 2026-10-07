/**
 * TS-214 (REQ-NON-FUNCTIONAL) — smaller correctness fixes from the seventh review.
 * - Wedding settings are saved compare-and-set: a save from a tab opened before another tab's
 *   change is refused with the latest values shown, instead of silently putting the change back.
 * - An RSVP cutoff before today, or after the wedding date, is only saved after "Save anyway".
 * - Guest "New link" and vendor "New link" ask first; Cancel makes no new link.
 * - A timeline entry marked "after midnight (next day)" is listed after the wedding day's own,
 *   on the Timeline tab and on a vendor's read-only page, shown as "12:30 AM (next day)".
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { VendorViewPage } from "../pages/VendorViewPage.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";


defineQualityTest(
  {
    id: "cross-cutting.review-7-smaller-correctness-fixes-hold.settings-saved-from-two-tabs",
    title: "a wedding setting saved from a tab opened before another tab's change is refused, never silently undoing it",
    objective:
      "Confirms that when tab 2 saves a new venue and tab 1 (opened earlier) then saves a new date, tab 1's save is refused with 409 and a message, the venue on record stays tab 2's, tab 1's venue box shows tab 2's venue, and saving the date again from tab 1 then works without touching the venue.",
    expectedOutcome:
      "Tab 1's first save answers 409 and shows 'This wedding's settings changed since you opened them'. The API venue is tab 2's venue and the date is still unset. Tab 1's venue box shows tab 2's venue. The second save from tab 1 answers 200; the API then has both the new date and tab 2's venue.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const w = managedWedding.id;
    const saved = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as {
        wedding: { eventDate: string | null; venueName: string | null };
      }).wedding;
    const tab1 = new CollaboratorsTabPage(page);
    const tab2 = new CollaboratorsTabPage(await context.newPage());
    await tab1.goto(w);
    await tab2.goto(w);

    await test.step("Tab 2 saves a new venue", async () => {
      await tab2.saveDateAndVenue("", "The Old Barn");
      await expect.poll(async () => (await saved()).venueName).toBe("The Old Barn");
    });

    await test.step("Tab 1, opened before that, changes only the date: refused, and the venue isn't put back", async () => {
      expect(await tab1.submitDateAndVenue("2027-06-12")).toBe(409);
      await expect(tab1.message(/^This wedding's settings changed since you opened them/)).toBeVisible();
      const after = await saved();
      expect(after.venueName).toBe("The Old Barn");
      expect(after.eventDate).toBeNull();
      await expect(tab1.venueInput()).toHaveValue("The Old Barn");
    });

    await test.step("Saving the date again from tab 1 works, and keeps tab 2's venue", async () => {
      await tab1.saveDateAndVenue("2027-06-12", "The Old Barn");
      const after = await saved();
      expect(after.eventDate).toBe("2027-06-12");
      expect(after.venueName).toBe("The Old Barn");
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-7-smaller-correctness-fixes-hold.past-rsvp-cutoff-asks-first",
    title: "an RSVP cutoff before today or after the wedding is only saved after Save anyway",
    objective:
      "Confirms that leaving the RSVP cutoff box with a date before today shows a question saying it's before today and saves nothing; that 'Change it' puts the saved value back; that 'Save anyway' saves it; and that a cutoff after the wedding date asks the same way.",
    expectedOutcome:
      "A past cutoff shows the question ('before today') with the API cutoff still null; 'Change it' empties the box; asked again, 'Save anyway' saves 2020-01-01. With the wedding on 2030-06-01, a 2030-07-01 cutoff asks ('after the wedding date') and is saved after 'Save anyway'.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@feature:rsvp", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const w = managedWedding.id;
    const saved = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as { wedding: { rsvpCutoffDate: string | null } })
        .wedding.rsvpCutoffDate;
    const settings = new CollaboratorsTabPage(page);
    const question = settings.rsvpCutoffQuestion();
    await settings.goto(w);

    await test.step("A cutoff before today asks first, and nothing is saved yet", async () => {
      await settings.setAndLeave(settings.rsvpCutoffInput(), "2020-01-01");
      await expect(question).toContainText("before today");
      await expect(question).toContainText("01-01-2020");
      expect(await saved()).toBeNull();
    });

    await test.step("'Change it' puts the saved value back", async () => {
      await settings.changeCutoff();
      await expect(question).toHaveCount(0);
      await expect(settings.rsvpCutoffInput()).toHaveValue("");
      expect(await saved()).toBeNull();
    });

    await test.step("'Save anyway' saves it", async () => {
      await settings.setAndLeave(settings.rsvpCutoffInput(), "2020-01-01");
      await settings.saveCutoffAnyway();
      await expect.poll(saved).toBe("2020-01-01");
      await expect(question).toHaveCount(0);
    });

    await test.step("A cutoff after the wedding date asks too", async () => {
      expect((await context.request.patch(`/api/v1/weddings/${w}`, { data: { eventDate: "2030-06-01" } })).ok()).toBe(true);
      await settings.goto(w);
      await settings.setAndLeave(settings.rsvpCutoffInput(), "2030-07-01");
      await expect(question).toContainText("after the wedding date");
      expect(await saved()).toBe("2020-01-01");
      await settings.saveCutoffAnyway();
      await expect.poll(saved).toBe("2030-07-01");
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-7-smaller-correctness-fixes-hold.new-link-asks-first",
    title: "guest and vendor New link ask first, and Cancel makes no new link",
    objective:
      "Confirms that a guest's 'New link' and a vendor's 'New link' each open an 'Are you sure?' question saying the current link stops working, that Cancel sends no request and keeps the old link working, and that 'Yes, make a new link' replaces the link.",
    expectedOutcome:
      "Each question mentions that the current link stops working. After Cancel no POST to rsvp-link or share-link was sent and the link is unchanged. After confirming, the guest's RSVP token and the vendor's link change.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:budget", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, page, context }, testInfo) => {
    const w = managedWedding.id;
    const base = `/api/v1/weddings/${w}`;
    const name = uniquePersonName(testInfo.workerIndex);
    const guest = await weddingData.createGuest(w, name);
    const rsvpUrl = async () =>
      ((await (await context.request.post(`${base}/guests/${guest.id}/rsvp-link`, { data: { regenerate: false } })).json()) as {
        rsvp: { url: string };
      }).rsvp.url;
    const linkRequests: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/(rsvp-link|share-link)$/.test(new URL(r.url()).pathname)) linkRequests.push(r.url());
    });

    await test.step("Guest New link: Cancel changes nothing; Yes makes a new link", async () => {
      const before = await rsvpUrl();
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      const row = weddingGuestsPage.guestRow(`${name.firstName} ${name.lastName}`);
      await row.newRsvpLinkButton().click();
      await expect(row.newLinkQuestion().question()).toContainText("stops working right away");
      await row.newLinkQuestion().cancel();
      expect(linkRequests).toEqual([]);
      expect(await rsvpUrl()).toBe(before);

      await row.requestNewRsvpLink();
      await expect(row.rsvpLinkResult()).toBeVisible();
      expect(await rsvpUrl()).not.toBe(before);
    });

    await test.step("Vendor New link: Cancel changes nothing; Yes makes a new link", async () => {
      const created = await context.request.post(`${base}/vendors`, { data: { name: "Bloom Florals", category: "FLORIST" } });
      expect(created.status()).toBe(201);
      const budget = new BudgetTabPage(page);
      await budget.goto(w);
      const first = await budget.getShareLink("Bloom Florals");
      linkRequests.length = 0;
      await budget.newLinkButton("Bloom Florals").click();
      const question = budget.newLinkQuestion("Bloom Florals");
      await expect(question.question()).toContainText("stops working right away");
      await question.cancel();
      expect(linkRequests).toEqual([]);
      const fresh = await budget.getShareLink("Bloom Florals", true);
      expect(fresh).not.toBe(first);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-7-smaller-correctness-fixes-hold.next-day-timeline-order",
    title: "a timeline entry after midnight is listed after the wedding day's own, on the Timeline tab and the vendor's page",
    objective:
      "Confirms that an entry added with 'After midnight (next day)' at 12:30 AM is listed after a 4:00 PM and an 11:00 PM entry (it used to sort first), shown as '12:30 AM (next day)', in the API, on the Timeline tab and on a vendor's read-only page; and that a vendor arriving at 1:30 AM is listed after one arriving at 10:00 AM, shown with '(next day)'.",
    expectedOutcome:
      "API order: Ceremony, Cake, Last dance. Timeline tab rows read 4:00 PM, 11:00 PM, then 12:30 AM (next day). The vendor page lists the same order and labels; its other vendors read 'Arrives 10:00 AM' then 'Arrives 1:30 AM (next day)'.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:timeline", "@feature:budget", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context, browser }) => {
    const w = managedWedding.id;
    const base = `/api/v1/weddings/${w}`;
    await weddingData.createTimelineEntry(w, { time: "16:00", description: "Ceremony" });
    await weddingData.createTimelineEntry(w, { time: "23:00", description: "Cake" });

    await test.step("Add a 12:30 AM next-day entry on the Timeline tab", async () => {
      const timeline = new TimelineTabPage(page);
      await timeline.goto(w);
      await timeline.addEntry("00:30", "Last dance", true);
      const entries = await weddingData.getTimelineEntries(w);
      expect(entries.map((e) => e.description)).toEqual(["Ceremony", "Cake", "Last dance"]);
      expect(entries[2].nextDay).toBe(true);
      await expect(timeline.entryRows()).toHaveText([/Ceremony/, /Cake/, /Last dance/]);
      await expect(timeline.entryTimeText("Ceremony")).toHaveText("4:00 PM");
      await expect(timeline.entryTimeText("Cake")).toHaveText("11:00 PM");
      await expect(timeline.entryTimeText("Last dance")).toHaveText("12:30 AM (next day)");
    });

    const visitor = await browser.newContext();
    try {
      await test.step("The vendor's page lists the same order, and an early-morning arrival after the day's", async () => {
        for (const v of [
          { name: "Shuttle Co", category: "TRANSPORTATION", arrivalTime: "01:30" },
          { name: "Petal Florals", category: "FLORIST", arrivalTime: "10:00" },
          { name: "Viewing Vendor", category: "OTHER", categoryOther: "Planner", arrivalTime: "09:00" },
        ]) {
          expect((await context.request.post(`${base}/vendors`, { data: v })).status()).toBe(201);
        }
        const vendors = (await (await context.request.get(`${base}/vendors`)).json()) as { vendors: { id: string; name: string }[] };
        const viewer = vendors.vendors.find((v) => v.name === "Viewing Vendor")!;
        const link = (await (await context.request.post(`${base}/vendors/${viewer.id}/share-link`, { data: { regenerate: false } })).json()) as {
          link: { url: string };
        };
        const vendorPage = new VendorViewPage(await visitor.newPage());
        await vendorPage.gotoUrl(link.link.url);
        const timelineItems = vendorPage.timeline().getByRole("listitem");
        await expect(timelineItems).toHaveText([/4:00 PM\s*Ceremony/, /11:00 PM\s*Cake/, /12:30 AM \(next day\)\s*Last dance/]);
        const others = vendorPage.otherVendors().getByRole("listitem");
        await expect(others).toHaveText([/Petal Florals.*Arrives 10:00 AM/, /Shuttle Co.*Arrives 1:30 AM \(next day\)/]);
      });
    } finally {
      await visitor.close();
    }
  },
);
