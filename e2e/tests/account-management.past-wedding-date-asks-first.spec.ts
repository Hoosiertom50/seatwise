/**
 * TS-263 (REQ-ACCOUNT-WEDDING-MANAGEMENT, Tom's decision 10-13) — a wedding date that has already
 * passed is allowed, but the planner is asked first: "This date (MM-DD-YYYY) has already passed —
 * is that right?" with "Save anyway" (saves it) and "Change it" (focus back in the date box). It
 * used to be saved without a word, and it's usually the wrong year. Asked on the dashboard's create
 * form and in Collaborators → Date and venue; duplicating a wedding doesn't copy or set a date.
 * An empty date, today or a later date saves straight away; the server still accepts past dates.
 * The rule itself (including "today" being the planner's own date) is unit-tested in
 * apps/web/src/lib/past-wedding-date.test.mts.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { uniqueTitle } from "../data/ids.js";
import { shownDate } from "../data/dates.js";
import { patchWedding } from "../data/api.js";

// Far enough either side of today that no time zone makes it today.
const PAST = "2020-05-16";
// Always about two years ahead of the day the test runs, so it never becomes a past date (and a
// second one a month after it).
const yearsAhead = (years: number, months = 0) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCFullYear(d.getUTCFullYear() + years, d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};
const FUTURE = yearsAhead(2);
const LATER_A = yearsAhead(3);
const LATER_B = yearsAhead(3, 1);

// Two of the page's 4-second checks, with headroom.
const WITHIN_SECONDS = { timeout: 10_000 };

const SETTINGS_CHANGED_ELSEWHERE =
  "This wedding's settings changed since you opened them (maybe in another tab) — showing the latest. Your change wasn't saved; make it again if it's still needed.";

defineQualityTest(
  {
    id: "account-management.past-wedding-date-asks-first.create-form",
    title: "creating a wedding with a past date asks first: Change it goes back to the date box, Save anyway creates it",
    objective:
      "Confirms (TS-263) that pressing Add wedding with a date before today shows 'This date (MM-DD-YYYY) has already passed — is that right?' and creates nothing; that 'Change it' closes the question, keeps the typed date and puts focus in the date box; that Add wedding asks again and 'Save anyway' then creates the wedding with that past date and opens it; and that a future date creates the wedding with no question.",
    expectedOutcome:
      "The question reads 'This date (05-16-2020) has already passed — is that right?' and no wedding with that name exists yet. After Change it: no question, the date box is focused and still reads 2020-05-16. After Save anyway: the browser is on the new wedding's page and the server has eventDate 2020-05-16. A wedding dated about two years ahead opens straight away.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ account, weddingData, page, context }, testInfo) => {
    void account;
    const dashboard = new DashboardPage(page);
    const name = uniqueTitle(testInfo.workerIndex, "Past Date Wedding");
    const listNames = async () =>
      ((await (await context.request.get("/api/v1/weddings")).json()) as { weddings: { name: string }[] }).weddings.map((w) => w.name);

    await test.step("Add wedding with a past date asks, and creates nothing yet", async () => {
      await dashboard.goto();
      await dashboard.submitNewWedding(name, PAST);
      await expect(dashboard.pastDateQuestion()).toContainText(`This date (${shownDate(PAST)}) has already passed — is that right?`);
      expect(await listNames()).not.toContain(name);
    });

    await test.step("Change it closes the question and puts focus back in the date box", async () => {
      await dashboard.changeDate();
      await expect(dashboard.pastDateQuestion()).toHaveCount(0);
      await expect(dashboard.newWeddingDateBox()).toBeFocused();
      await expect(dashboard.newWeddingDateBox()).toHaveValue(PAST);
      expect(await listNames()).not.toContain(name);
    });

    await test.step("Save anyway creates the wedding with the past date and opens it", async () => {
      await dashboard.submitNewWedding(name, PAST);
      await expect(dashboard.pastDateQuestion()).toBeVisible();
      await dashboard.saveDateAnyway();
      const weddingId = new URL(page.url()).pathname.split("/").pop()!;
      weddingData.trackWedding(weddingId);
      const saved = ((await (await context.request.get(`/api/v1/weddings/${weddingId}`)).json()) as { wedding: { name: string; eventDate: string | null } }).wedding;
      expect(saved).toMatchObject({ name, eventDate: PAST });
    });

    await test.step("A future date creates the wedding with no question", async () => {
      const later = uniqueTitle(testInfo.workerIndex, "Future Date Wedding");
      await dashboard.goto();
      await Promise.all([page.waitForURL(/\/weddings\/[^/]+$/), dashboard.submitNewWedding(later, FUTURE)]);
      weddingData.trackWedding(new URL(page.url()).pathname.split("/").pop()!);
    });
  },
);

defineQualityTest(
  {
    id: "account-management.past-wedding-date-asks-first.date-and-venue",
    title: "saving a past date in Collaborators → Date and venue asks first: Change it goes back to the date box, Save anyway saves it",
    objective:
      "Confirms (TS-263) that in the owner's Date and venue box, Save with a date before today shows the 'has already passed' question and saves nothing; that 'Change it' closes it with the typed date kept and focus in the date box; that Save then 'Save anyway' saves the past date; that saving only a new venue while that past date is saved asks nothing; and that a future date saves with no question.",
    expectedOutcome:
      "The question reads 'This date (05-16-2020) has already passed — is that right?' and the server's eventDate is unchanged (null). After Change it: no question, the date box is focused and reads 2020-05-16. After Save anyway: the PATCH answers 200, 'Saved' shows and the server has 2020-05-16. A new venue then saves with no question, and a date two years ahead saves with no question.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const w = managedWedding.id;
    const tab = new CollaboratorsTabPage(page);
    const saved = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as { wedding: { eventDate: string | null; venueName: string | null } }).wedding;
    await tab.goto(w);

    await test.step("Save with a past date asks, and saves nothing yet", async () => {
      await tab.pressSaveDateAndVenue(PAST);
      await expect(tab.pastDateQuestion()).toContainText(`This date (${shownDate(PAST)}) has already passed — is that right?`);
      expect((await saved()).eventDate).toBeNull();
    });

    await test.step("Change it closes the question and puts focus back in the date box", async () => {
      await tab.changeDate();
      await expect(tab.pastDateQuestion()).toHaveCount(0);
      await expect(tab.weddingDateInput()).toBeFocused();
      await expect(tab.weddingDateInput()).toHaveValue(PAST);
      expect((await saved()).eventDate).toBeNull();
    });

    await test.step("Save, then Save anyway, saves the past date", async () => {
      await tab.pressSaveDateAndVenue(PAST);
      await expect(tab.pastDateQuestion()).toBeVisible();
      expect(await tab.saveDateAnyway()).toBe(200);
      await expect(tab.pastDateQuestion()).toHaveCount(0);
      await expect(tab.dateAndVenueSaved()).toBeVisible();
      expect((await saved()).eventDate).toBe(PAST);
    });

    await test.step("Only a new venue, with the past date already saved, asks nothing", async () => {
      await tab.saveDateAndVenue(PAST, "The Old Barn");
      await expect(tab.pastDateQuestion()).toHaveCount(0);
      expect(await saved()).toMatchObject({ eventDate: PAST, venueName: "The Old Barn" });
    });

    await test.step("A future date saves with no question", async () => {
      await tab.saveDateAndVenue(FUTURE, "The Old Barn");
      await expect(tab.pastDateQuestion()).toHaveCount(0);
      expect((await saved()).eventDate).toBe(FUTURE);
    });
  },
);

defineQualityTest(
  {
    id: "account-management.past-wedding-date-asks-first.save-anyway-respects-the-other-tab",
    title: "the past wedding date's Save anyway is refused when the date was saved elsewhere meanwhile, and the next change saves",
    objective:
      "Confirms (TS-263, following TS-246/TS-251) that when the owner has the 'has already passed' question up for a wedding date, and the date is saved elsewhere (another tab) meanwhile, pressing 'Save anyway' -- after the page's 4-second check has brought in the newer settings -- doesn't overwrite it: it is refused with 'changed since you opened them', the question goes and the box shows the newer date. A fresh change afterwards saves normally.",
    expectedOutcome:
      "After Save anyway: the 'changed since you opened them' message shows, the question is gone, the date box reads the other tab's future date and the server keeps it. Then a later future date saves with 'Saved' and no message.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const w = managedWedding.id;
    const tab = new CollaboratorsTabPage(page);
    const savedDate = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as { wedding: { eventDate: string | null } }).wedding.eventDate;
    await tab.goto(w);

    await test.step("The question is up while the date is saved elsewhere", async () => {
      await tab.pressSaveDateAndVenue(PAST);
      await expect(tab.pastDateQuestion()).toBeVisible();
      expect((await patchWedding(context.request, w, { data: { eventDate: LATER_A } })).ok()).toBe(true);
      // A check sent after that save has answered carries the newer settings.
      for (let i = 0; i < 2; i++)
        await page.waitForResponse(
          (r) => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1/weddings/${w}`,
          WITHIN_SECONDS,
        );
      await expect(tab.pastDateQuestion()).toBeVisible();
    });

    await test.step("Save anyway is refused, and the newer date stays", async () => {
      await tab.pressSaveDateAnyway();
      await expect(tab.message(SETTINGS_CHANGED_ELSEWHERE)).toBeVisible();
      await expect(tab.pastDateQuestion()).toHaveCount(0);
      await expect(tab.weddingDateInput()).toHaveValue(LATER_A);
      expect(await savedDate()).toBe(LATER_A);
    });

    await test.step("A fresh change then saves", async () => {
      await tab.saveDateAndVenue(LATER_B, "");
      expect(await savedDate()).toBe(LATER_B);
      await expect(tab.message(SETTINGS_CHANGED_ELSEWHERE)).toHaveCount(0);
    });
  },
);
