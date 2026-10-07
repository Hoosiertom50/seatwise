/**
 * TS-177 (REQ-GUEST-LIST-MANAGEMENT, REQ-CLIENT-RSVP-COLLECTION, REQ-NON-FUNCTIONAL) — the Guests
 * tab's messages and counts say what actually happened:
 * - After the RSVP cutoff, Seatwise doesn't email a guest their RSVP link (it would only open a
 *   "closed" page); the link is still made, the planner is told, and no email allowance is used.
 * - A guest import's Side column takes the wedding's own side names (and Both), as the Guests tab's
 *   instructions say, and an unknown value is named with those words.
 * - Guest counts on the Guests tab and the dashboard both show invitations and people.
 * - An email a limit refuses uses up none of the other limits, and when it's the account's daily
 *   allowance the message says "tomorrow" rather than "a short time".
 * - Editing a guest only says they were flagged when that edit flagged them, in words that fit why.
 * Email is only logged in tests; the limit counters are read and set in the local test database.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { waitUntilSafelyInsideUtcDay } from "../support/utcDay.js";
import { uniquePersonName, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { accountEmailCount, ageTestAccount, setAccountEmailCount } from "../support/testDatabase.js";
import { DashboardPage } from "../pages/DashboardPage.js";

const RSVP_CLOSED_NOTE =
  'RSVPs have closed, so this guest wasn\'t emailed — use "RSVP link" to copy it if you still want to send it.';
const ACCOUNT_DAILY_LIMIT_MESSAGE = "You've reached today's email limit for your account — you can send more tomorrow.";

type RsvpEmail = {
  emailed: boolean;
  emailFailed: boolean;
  emailLimited: boolean;
  emailLimitedToday: boolean;
  rsvpClosed: boolean;
};

defineQualityTest(
  {
    id: "guest-list.what-planners-are-told-matches-what-happened.rsvp-closed-not-emailed",
    title: "after the RSVP cutoff a guest isn't emailed their RSVP link, the link is still made, the planner is told why, and no email allowance is used",
    objective:
      "Confirms that with the wedding's RSVP cutoff in the past, adding a guest with an email and asking for their RSVP link both make the link without emailing it (rsvpClosed), that the Guests tab shows the planner the 'RSVPs have closed' note, and that the account's email counters don't move.",
    expectedOutcome:
      "Adding by API: rsvpEmail.emailed false, emailFailed false, rsvpClosed true. RSVP link: url ends /rsvp/<token>, emailed false, rsvpClosed true. The guest added in the UI shows the 'RSVPs have closed, so this guest wasn't emailed' note on their row. The account's daily and hourly RSVP email counts stay 0.",
    requirementIds: ["REQ-CLIENT-RSVP-COLLECTION", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, account, weddingGuestsPage }, testInfo) => {
    // TS-200: this test reads the account's daily email counts -- they must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const w = managedWedding.id;
    const email = () => `pw-guest-closed-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
    await weddingData.updateWedding(w, { rsvpCutoffDate: "2025-01-15" });

    await test.step("Adding a guest with an email after the cutoff doesn't email them", async () => {
      const res = await context.request.post(`/api/v1/weddings/${w}/guests`, { data: { ...uniquePersonName(testInfo.workerIndex), email: email() } });
      expect(res.status()).toBe(201);
      const { guest, rsvpEmail } = (await res.json()) as { guest: { id: string }; rsvpEmail: RsvpEmail };
      expect(rsvpEmail).toMatchObject({ emailed: false, emailFailed: false, rsvpClosed: true });

      const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: { regenerate: false } });
      expect(link.ok()).toBe(true);
      const { rsvp } = (await link.json()) as { rsvp: RsvpEmail & { url: string } };
      expect(rsvp.url).toMatch(/\/rsvp\/[^/]+$/);
      expect(rsvp).toMatchObject({ emailed: false, rsvpClosed: true });
    });

    await test.step("The Guests tab tells the planner the guest wasn't emailed, and why", async () => {
      const name = uniquePersonName(testInfo.workerIndex);
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      await weddingGuestsPage.addGuest({ ...name, email: email() });
      await expect(weddingGuestsPage.guestRow(`${name.firstName} ${name.lastName}`).autoRsvpResult()).toHaveText(RSVP_CLOSED_NOTE);
    });

    await test.step("None of it counted against the account's email limits", async () => {
      expect(await accountEmailCount(account.email, "account-day")).toBe(0);
      expect(await accountEmailCount(account.email, "rsvp-emails-hour")).toBe(0);
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.what-planners-are-told-matches-what-happened.import-side-uses-wedding-names",
    title: "a guest import's Side column accepts the wedding's own side names and Both, and names them when a value isn't one",
    objective:
      "Confirms that for a wedding whose sides are called Alex and Jordan, an import preview reads 'Alex', 'jordan', 'Both' and 'Bride' as the first side, second side, both and first side, that 'Sam' is a row error listing 'Alex, Jordan or Both', and that committing the valid rows saves those sides.",
    expectedOutcome:
      "Preview rows 1–4 are 'new' with side BRIDE, GROOM, BOTH, BRIDE; row 5 is an error reading 'Side \"Sam\" isn't one of Alex, Jordan or Both.'. Committing rows 1–4 creates 4 guests whose sides are BRIDE, GROOM, BOTH and BRIDE.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const w = managedWedding.id;
    await weddingData.updateWedding(w, { sideLabel1: "Alex", sideLabel2: "Jordan" });
    const names = Array.from({ length: 5 }, () => uniquePersonName(testInfo.workerIndex));
    const sides = ["Alex", " jordan ", "Both", "Bride", "Sam"];
    const csvFor = (count: number) =>
      ["firstName,lastName,side", ...names.slice(0, count).map((n, i) => `${n.firstName},${n.lastName},${sides[i]}`)].join("\n");
    const mapping = { firstName: "firstName", lastName: "lastName", side: "side" };

    await test.step("The preview reads the wedding's side names, and names them for a value it doesn't know", async () => {
      const res = await context.request.post(`/api/v1/weddings/${w}/guests/import/preview`, { data: { csv: csvFor(5), mapping } });
      expect(res.ok()).toBe(true);
      const { preview } = (await res.json()) as {
        preview: { rows: { kind: string; reason?: string; preview: { side?: string } }[] };
      };
      expect(preview.rows.slice(0, 4).map((r) => r.kind)).toEqual(["new", "new", "new", "new"]);
      expect(preview.rows.slice(0, 4).map((r) => r.preview.side)).toEqual(["BRIDE", "GROOM", "BOTH", "BRIDE"]);
      expect(preview.rows[4].kind).toBe("error");
      expect(preview.rows[4].reason).toBe(`Side "Sam" isn't one of Alex, Jordan or Both.`);
    });

    await test.step("Committing the valid rows saves those sides", async () => {
      const res = await context.request.post(`/api/v1/weddings/${w}/guests/import/commit`, { data: { csv: csvFor(4), mapping } });
      expect(res.ok()).toBe(true);
      expect(((await res.json()) as { result: { createdCount: number } }).result.createdCount).toBe(4);
      const guests = (await (await context.request.get(`/api/v1/weddings/${w}/guests`)).json()) as {
        guests: { lastName: string; side: string }[];
      };
      const sideOf = (lastName: string) => guests.guests.find((g) => g.lastName === lastName)?.side;
      expect(names.slice(0, 4).map((n) => sideOf(n.lastName))).toEqual(["BRIDE", "GROOM", "BOTH", "BRIDE"]);
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.what-planners-are-told-matches-what-happened.counts-show-invitations-and-people",
    title: "the Guests tab and the dashboard both count invitations and people, the same way",
    objective:
      "Confirms that with one guest of headcount 2 and one of headcount 1, the Guests tab's heading and the wedding's dashboard row both read '2 invitations · 3 people invited · 3 attending' (TS-214: invited and attending), and that with a single one-person guest they read '1 invitation · 1 person invited · 1 attending'.",
    expectedOutcome:
      "Guests tab heading: 'Guests (1 invitation · 1 person invited · 1 attending)', then 'Guests (2 invitations · 3 people invited · 3 attending)'. Dashboard row: contains '2 invitations · 3 people invited · 3 attending'.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-PLANNER-PORTFOLIO"],
    tags: ["@mutating", "@feature:guests", "@feature:portfolio", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, page }, testInfo) => {
    const w = managedWedding.id;
    await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), headcount: 1 });

    await test.step("One one-person guest: singular words", async () => {
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      await expect(weddingGuestsPage.guestListHeading()).toHaveText("Guests (1 invitation · 1 person invited · 1 attending)");
    });

    await test.step("Add a guest bringing two: both places read 2 invitations · 3 people", async () => {
      await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), headcount: 2 });
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      await expect(weddingGuestsPage.guestListHeading()).toHaveText("Guests (2 invitations · 3 people invited · 3 attending)");

      const dashboard = new DashboardPage(page);
      await dashboard.goto();
      await expect(dashboard.weddingLink(managedWedding.name)).toContainText("2 invitations · 3 people invited · 3 attending");
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.what-planners-are-told-matches-what-happened.refused-emails-use-up-nothing",
    title: "an email refused by the account's daily allowance uses up no other limit, and the message says it's until tomorrow",
    objective:
      "Confirms that with the account's daily email allowance used up, an invite is refused with the 'today's email limit for your account' message and a guest's RSVP email is held back (emailLimited, emailLimitedToday), that neither counts against the hourly or daily invite limits or the hourly RSVP email limit, and that the guest's hourly re-send cooldown wasn't used either -- once the allowance is back, asking for their link emails it.",
    expectedOutcome:
      "Invite: 429 with exactly \"You've reached today's email limit for your account — you can send more tomorrow.\". Guest: rsvpEmail.emailed false, emailLimited true, emailLimitedToday true. Invites-hour, invites-day and rsvp-emails-hour counts stay 0. With the allowance reset: the RSVP link returns emailed true, and an invite returns 201.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:collaboration", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, context, account }, testInfo) => {
    // TS-200: this test sets the account's daily allowance and reads the other counters -- they
    // must all be in one UTC day.
    await waitUntilSafelyInsideUtcDay(testInfo);
    const w = managedWedding.id;
    const invite = () =>
      context.request.post(`/api/v1/weddings/${w}/invites`, {
        data: { email: `pw-invitee-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`, permissionLevel: "VIEW" },
      });
    let guestId = "";

    await test.step("With the day's allowance used up, an invite and an RSVP email are both refused, saying it's until tomorrow", async () => {
      // TS-194: an account past its first week (a new one has a smaller allowance, with its own words).
      await ageTestAccount(account.email, 8);
      await setAccountEmailCount(account.email, "account-day", 100);
      const refused = await invite();
      expect(refused.status()).toBe(429);
      expect(((await refused.json()) as { error: string }).error).toBe(ACCOUNT_DAILY_LIMIT_MESSAGE);

      const res = await context.request.post(`/api/v1/weddings/${w}/guests`, {
        data: { ...uniquePersonName(testInfo.workerIndex), email: `pw-guest-limited-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}` },
      });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as { guest: { id: string }; rsvpEmail: RsvpEmail };
      guestId = body.guest.id;
      expect(body.rsvpEmail).toMatchObject({ emailed: false, emailLimited: true, emailLimitedToday: true });
    });

    await test.step("Neither refusal counted against any other limit", async () => {
      expect(await accountEmailCount(account.email, "invites-hour")).toBe(0);
      expect(await accountEmailCount(account.email, "invites-day")).toBe(0);
      expect(await accountEmailCount(account.email, "rsvp-emails-hour")).toBe(0);
    });

    await test.step("With the allowance back, the guest's link is emailed (the hourly cooldown wasn't used) and invites work", async () => {
      await setAccountEmailCount(account.email, "account-day", 0);
      const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guestId}/rsvp-link`, { data: { regenerate: false } });
      expect(link.ok()).toBe(true);
      expect(((await link.json()) as { rsvp: RsvpEmail }).rsvp.emailed).toBe(true);
      expect((await invite()).status()).toBe(201);
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.what-planners-are-told-matches-what-happened.edit-warns-only-when-it-flags",
    title: "editing a guest only warns that they were flagged when that edit flagged them, in words that fit why",
    objective:
      "Confirms that a guest already flagged Needs Reassignment because their table shrank gets no 'no longer fits a hard rule' warning when another of their fields is edited, and that a seated guest newly needing an accessible table gets a warning saying exactly that.",
    expectedOutcome:
      "After the table drops to 1 seat, one guest is flagged. Editing that guest's tier returns warnings []. Editing the other guest to require an accessible table returns one warning: '<name> needs an accessible table and their current table isn't one — flagged as Needs Reassignment.'",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-CROSS-CUTTING-HARD-RULE-INVARIANT"],
    tags: ["@mutating", "@feature:guests", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const w = managedWedding.id;
    const a = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const b = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const table = await weddingData.createTable(w, { label: "Shrinking", capacity: 2 });
    const plan = await weddingData.generatePlanVersion(w);
    expect(plan.assignments.filter((x) => x.tableId === table.id)).toHaveLength(2);
    const fullName = (g: { id: string }) => {
      const n = g.id === a.id ? a : b;
      return `${n.firstName} ${n.lastName}`;
    };

    let flaggedId = "";
    let otherId = "";
    await test.step("Arrange: the table drops to one seat, flagging one of them", async () => {
      await weddingData.updateTable(w, table.id, { capacity: 1 });
      const detail = await weddingData.getPlanVersionDetail(w, plan.id);
      const flagged = detail.assignments.filter((x) => x.needsReassignment);
      expect(flagged).toHaveLength(1);
      flaggedId = flagged[0].guestId;
      otherId = flaggedId === a.id ? b.id : a.id;
    });

    await test.step("Editing the already-flagged guest says nothing about a hard rule", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${w}/guests/${flaggedId}`, { data: { tier: "FAMILY" } });
      expect(res.ok()).toBe(true);
      expect(((await res.json()) as { warnings: string[] }).warnings).toEqual([]);
    });

    await test.step("Newly needing an accessible table says so", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${w}/guests/${otherId}`, { data: { requiresAccessibleTable: true } });
      expect(res.ok()).toBe(true);
      expect(((await res.json()) as { warnings: string[] }).warnings).toEqual([
        `${fullName({ id: otherId })} needs an accessible table and their current table isn't one — flagged as Needs Reassignment.`,
      ]);
    });
  },
);
