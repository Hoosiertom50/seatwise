/**
 * TS-116 (REQ-COLLABORATION-NOTIFICATIONS) — page object for the wedding detail page's
 * Collaborators tab (apps/web/src/app/weddings/[weddingId]/components/CollaboratorsTab.tsx): the
 * owner's invite form and pending-invite list, and the "People with access" list with its
 * per-person role/level selects and Remove button. Locators come from the component's own labels
 * and aria-labels; a pending invite or a person is found by the row that contains their email.
 */

import { BasePage } from "./BasePage.js";
import { ConfirmDelete } from "../components/ConfirmDelete.js";

export type AccessLevelLabel = "View" | "Comment" | "Edit";
export type RoleLabel = "Collaborator" | "Couple";

export class CollaboratorsTabPage extends BasePage {
  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
    await this.page.getByRole("tab", { name: "Collaborators", exact: true }).click();
    await this.peopleHeading().waitFor();
  }

  /** "People with access (N)" -- present for every access level once the tab has loaded. */
  peopleHeading() {
    return this.page.getByRole("heading", { level: 2, name: /^People with access \(\d+\)$/ });
  }

  /** The owner-only invite form's heading. */
  inviteFormHeading() {
    return this.page.getByRole("heading", { name: "Invite a collaborator", exact: true });
  }

  async sendInvite(email: string, level: AccessLevelLabel, role: RoleLabel = "Collaborator"): Promise<void> {
    await this.page.getByLabel("Email address", { exact: true }).fill(email);
    await this.page.getByLabel("Role", { exact: true }).selectOption({ label: role });
    await this.page.getByLabel("Access level", { exact: true }).selectOption({ label: level });
    await this.page.getByRole("button", { name: "Send invite", exact: true }).click();
  }

  inviteSentMessage(email: string) {
    return this.page.getByText(`Invite sent to ${email}.`, { exact: true });
  }

  /** A row in "Pending invites" -- its text includes role, level, and Pending/Expired. */
  pendingInvite(email: string) {
    return this.page.getByRole("listitem").filter({ hasText: email }).filter({ has: this.page.getByRole("button", { name: "Revoke" }) });
  }

  async revokeInvite(email: string): Promise<void> {
    await this.pendingInvite(email).getByRole("button", { name: /^Revoke/ }).click();
    await new ConfirmDelete(this.pendingInvite(email)).confirm();
  }

  /** A person's row in "People with access". */
  person(email: string) {
    return this.page.getByRole("listitem").filter({ hasText: email }).filter({ hasNotText: /Pending|Expired/ });
  }

  async setAccessLevel(personName: string, level: AccessLevelLabel): Promise<void> {
    await this.page.getByLabel(`Access level for ${personName}`, { exact: true }).selectOption({ label: level });
  }

  async setRole(personName: string, role: RoleLabel): Promise<void> {
    await this.page.getByLabel(`Role for ${personName}`, { exact: true }).selectOption({ label: role });
  }

  accessLevelSelect(personName: string) {
    return this.page.getByLabel(`Access level for ${personName}`, { exact: true });
  }

  async removePerson(email: string): Promise<void> {
    await this.person(email).getByRole("button", { name: /^Remove / }).click();
    await new ConfirmDelete(this.person(email)).confirm();
  }

  // TS-118: the owner-only wedding settings on this tab. Each saves when the field loses focus.
  weddingNameInput() {
    return this.page.getByLabel("Wedding name", { exact: true });
  }
  sideLabelInput(which: 1 | 2) {
    return this.page.getByLabel(`Side ${which}`, { exact: true });
  }
  weddingNoteInput() {
    return this.page.getByLabel("Wedding note", { exact: true });
  }
  rsvpCutoffInput() {
    return this.page.getByLabel("RSVP cutoff date", { exact: true });
  }
  emailNotificationsCheckbox() {
    return this.page.getByRole("checkbox", { name: /^Also send email notifications for this wedding/ });
  }
  /** Replaces a settings field's value and leaves the field, which is what saves it. (Blur rather
   * than Tab: in a date input, Tab only moves between its month/day/year parts.) */
  async setAndLeave(field: ReturnType<CollaboratorsTabPage["weddingNameInput"]>, value: string): Promise<void> {
    await field.fill(value);
    await field.blur();
  }
  /** The tab's error line, matched by its text. */
  message(text: string | RegExp) {
    return typeof text === "string" ? this.page.getByText(text, { exact: true }) : this.page.getByText(text);
  }

  /** TS-105: hands the wedding to `personName`, answering "Yes"; the page reloads afterwards. */
  async handOffTo(personName: string): Promise<void> {
    await this.page.getByLabel("New owner", { exact: true }).selectOption({ label: personName });
    await this.page.getByRole("button", { name: "Hand off", exact: true }).click();
    await Promise.all([
      this.page.waitForEvent("load"),
      new ConfirmDelete(this.page).confirm(),
    ]);
  }

  handOffSection() {
    return this.page.getByRole("heading", { name: "Hand off this wedding", exact: true });
  }

  /** Every Remove button on the tab -- none should render for a non-owner. */
  removeButtons() {
    return this.page.getByRole("button", { name: /^Remove / });
  }

  /** TS-148: the whole page, for checking what text is or isn't shown. */
  root() {
    return this.page.locator("main");
  }

  /** TS-148: a collaborator leaves the wedding from their own row; ends back on the dashboard. */
  async leaveWedding(): Promise<void> {
    await this.page.getByRole("button", { name: "Leave this wedding", exact: true }).click();
    await this.page.getByRole("button", { name: "Yes, leave", exact: true }).click();
    await this.page.waitForURL((url) => url.pathname === "/dashboard");
  }

  /** TS-154: sets the wedding's date and venue in the owner settings and waits for the save. */
  async saveDateAndVenue(date: string, venue: string): Promise<void> {
    await this.page.getByLabel("Wedding date", { exact: true }).fill(date);
    await this.page.getByLabel("Venue", { exact: true }).fill(venue);
    await Promise.all([
      this.page.waitForResponse((r) => r.request().method() === "PATCH" && /\/api\/v1\/weddings\/[^/]+$/.test(new URL(r.url()).pathname)),
      this.page.getByRole("button", { name: "Save date and venue", exact: true }).click(),
    ]);
    await this.page.getByRole("status").filter({ hasText: /^Saved$/ }).waitFor();
  }

  // TS-161: the owner-only "Delete this wedding" section.
  deleteWeddingConfirmInput() {
    return this.page.getByLabel(/Type the wedding.s name/);
  }

  deleteWeddingButton() {
    return this.page.getByRole("button", { name: "Delete wedding", exact: true });
  }

  /** The error shown inside the delete section when a delete fails. */
  deleteWeddingError() {
    return this.page.getByRole("heading", { name: "Delete this wedding", exact: true }).locator("..").getByRole("alert");
  }

  async confirmDelete(): Promise<void> {
    await new ConfirmDelete(this.page).confirm();
  }

  /** Types the name, clicks Delete wedding, confirms, and waits for the dashboard. */
  async deleteWedding(name: string): Promise<void> {
    await this.deleteWeddingConfirmInput().fill(name);
    await this.deleteWeddingButton().click();
    await new ConfirmDelete(this.page).confirm();
    await this.page.waitForURL(/\/dashboard$/);
  }
}
