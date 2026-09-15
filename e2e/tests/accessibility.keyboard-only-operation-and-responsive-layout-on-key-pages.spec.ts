/**
 * TS-53 (REQ-NON-FUNCTIONAL) — the keyboard-navigation and responsiveness half of the scope
 * confirmed with Tom on this story (see its companion file,
 * accessibility.automated-axe-scans-find-zero-wcag-aa-violations-on-key-pages.spec.ts, for the
 * axe-core half and the full scope rationale). An automated axe scan cannot, by itself, prove a
 * form is actually operable by Tab/Enter alone (it can only see whether elements are individually
 * focusable/labeled, not whether a real keyboard-only user could complete a task end to end), and
 * it says nothing at all about layout at a narrower viewport -- these two scenarios cover that gap.
 *
 * Two independent scenarios, two separate defineQualityTest calls:
 *
 * 1. Keyboard-only operation of two representative, real forms -- log in, and add a guest -- each
 *    driven by real `page.keyboard` input (`.focus()` + `.type()`/`.press("Tab"/"Enter")`, never
 *    `.fill()`/`.click()`, which bypass real key events and would prove nothing here). Confirms
 *    every field is reachable in order by Tab alone and that Enter on the last field submits the
 *    form -- both forms have no other submit control a keyboard-only user could fall back on.
 * 2. No horizontal overflow at a phone (375px), tablet (768px), and desktop (1280px) width, on the
 *    dashboard and all 10 wedding-detail tabs -- the same `scrollWidth`-vs-`clientWidth` technique
 *    README.md's own prior NFR-9.5b exercise used (there: 6 widths, 8 tabs, "48 checks, zero
 *    overflow"), trimmed to 3 widths per Tom's confirmed "basic" scope but extended to the 10
 *    current tabs (that exercise predates the Timeline/Budget tabs -- see the axe-scan file's own
 *    header comment for the same discrepancy).
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { uniquePersonName, uniqueToken } from "../data/ids.js";

defineQualityTest(
  {
    id: "accessibility.keyboard-only-operation-and-responsive-layout-on-key-pages.log-in-and-add-a-guest-work-with-only-a-keyboard",
    title: "logging in and adding a guest each complete successfully using only Tab, typed keys, and Enter -- no mouse click anywhere in either flow",
    objective:
      "Confirms two representative, real forms (the login form, and the Guests tab's add-guest form) are each fully operable by a keyboard-only user: every field is reachable from the previous one by pressing Tab (never skipped, never landing somewhere unexpected), and pressing Enter on the last field submits the form exactly as clicking its own submit button would.",
    expectedOutcome:
      "Typing an existing account's email, pressing Tab (landing on the password field), typing the password, and pressing Enter logs in and reaches the dashboard. On the Guests tab, typing a first name, pressing Tab (landing on the last-name field), typing a last name, and pressing Enter adds the guest and it appears in the guest list -- with no click anywhere in either flow.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:non-functional", "@risk:normal", "@suite:regression"],
  },
  // Deliberately does NOT use the `account`/`managedWedding` fixtures: those sign up via a direct
  // API call (see e2e/support/auth.ts) and never expose the account's own password (by design --
  // "never persisted anywhere by this module once the signup request returns"), so there would be
  // no password to drive `loginWithKeyboardOnly` with. Same reasoning as
  // auth.signup-login-logout.spec.ts's own header comment: this test's account is scaffolding for
  // the keyboard-login step itself, so it's created fresh, through the real UI, with a password
  // this test generates and keeps.
  async ({ signupPage, loginPage, page, context }, testInfo) => {
    const token = uniqueToken(testInfo.workerIndex);
    const name = `Keyboard Tester ${token}`;
    const email = `pw-keyboard-${token}@example.invalid`;
    const password = randomBytes(16).toString("base64url");

    const dashboardPage = new DashboardPage(page);
    await test.step("Arrange: sign up a fresh account and log out, so there's a known password to log back in with", async () => {
      await signupPage.goto();
      await signupPage.signUp(name, email, password);
      await page.waitForURL("/dashboard");
      await dashboardPage.logout();
      await page.waitForURL("/login");
    });

    await test.step("Act + Assert: logging in with only Tab/type/Enter reaches the dashboard", async () => {
      await loginPage.goto();
      await loginPage.loginWithKeyboardOnly(email, password);
      await expect(page).toHaveURL(/\/dashboard$/);
    });

    let weddingId = "";
    await test.step("Arrange: a wedding for this freshly-logged-in-by-keyboard session", async () => {
      const res = await context.request.post("/api/v1/weddings", {
        data: { name: `Keyboard Wedding ${token}` },
      });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as { wedding: { id: string } };
      weddingId = body.wedding.id;
    });

    const guestsPage = new WeddingGuestsPage(page);
    const guest = uniquePersonName(testInfo.workerIndex);
    const fullName = `${guest.firstName} ${guest.lastName}`;
    await test.step("Act + Assert: adding a guest with only Tab/type/Enter adds them to the list", async () => {
      await guestsPage.goto(weddingId);
      await guestsPage.openGuestsTab();
      await guestsPage.addGuestWithKeyboardOnly(guest.firstName, guest.lastName);
      await guestsPage.guestRow(fullName).expectVisible();
    });
  },
);

const RESPONSIVE_WIDTHS = [
  { label: "phone", width: 375, height: 812 },
  { label: "tablet", width: 768, height: 1024 },
  { label: "desktop", width: 1280, height: 800 },
];

defineQualityTest(
  {
    id: "accessibility.keyboard-only-operation-and-responsive-layout-on-key-pages.no-horizontal-overflow-on-the-dashboard-or-any-wedding-tab-at-phone-tablet-or-desktop-width",
    title: "the dashboard and every one of the 10 wedding-detail tabs render with no horizontal scrolling at a phone (375px), tablet (768px), or desktop (1280px) viewport width",
    objective:
      "Confirms every key page's rendered content stays within its own viewport width -- document.documentElement.scrollWidth never exceeds clientWidth by more than a hairline rounding tolerance -- at each of a phone, tablet, and desktop width, satisfying AC-080's 'usable on both desktop and mobile screen sizes' claim as a basic, automatable proxy (no content overlap or forced page-level horizontal scroll).",
    expectedOutcome:
      "At each of 375px, 768px, and 1280px, the dashboard and all 10 wedding tabs (Guests, Seating rules, Tables, Seating plan, Day-of mode, Timeline, Budget, Comments, Activity, Collaborators) each have scrollWidth <= clientWidth + 1.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:non-functional", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    await test.step("Arrange: a guest and a table so list-bearing tabs render a real row, not just their empty state", async () => {
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.createTable(managedWedding.id, { label: "Overflow Check Table", capacity: 4 });
    });

    async function assertNoHorizontalOverflow(viewName: string): Promise<void> {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        scrollWidth,
        `${viewName} should not force horizontal scrolling (scrollWidth ${scrollWidth} vs clientWidth ${clientWidth})`,
      ).toBeLessThanOrEqual(clientWidth + 1);
    }

    const weddingDetail = new WeddingDetailPage(page);
    const tabLabels = [
      "Guests",
      "Seating rules",
      "Tables",
      "Seating plan",
      "Day-of mode",
      "Timeline",
      "Budget",
      "Comments",
      "Activity",
      "Collaborators",
    ];

    for (const { label: widthLabel, width, height } of RESPONSIVE_WIDTHS) {
      await test.step(`Assert: no horizontal overflow at ${widthLabel} width (${width}px)`, async () => {
        await page.setViewportSize({ width, height });

        await page.goto("/dashboard");
        await page.waitForLoadState("networkidle");
        await assertNoHorizontalOverflow(`dashboard @ ${widthLabel}`);

        await weddingDetail.goto(managedWedding.id);
        for (const label of tabLabels) {
          await weddingDetail.openTab(label);
          await assertNoHorizontalOverflow(`"${label}" tab @ ${widthLabel}`);
        }
      });
    }
  },
);
