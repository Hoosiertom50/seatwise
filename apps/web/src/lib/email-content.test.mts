// TS-168: unit tests for what notification emails may say, and the rules for a copied wedding's
// name. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emailSafeNotificationText } from "../../../../packages/db/src/queries/notifications";
import { copiedWeddingName } from "../../../../packages/shared/src/schemas/wedding";
import { duplicateWeddingSchema as duplicateFromTemplate } from "../../../../packages/shared/src/schemas/template";
import { emailSafeWeddingName } from "../../../../packages/shared/src/email-safe-names";

test("a notification whose text could read as a web address isn't emailed as written", () => {
  assert.equal(emailSafeNotificationText("Ana Ruiz is coming."), "Ana Ruiz is coming.");
  assert.equal(
    emailSafeNotificationText("Claim at evilsite.com is coming."),
    "There's an update on a wedding you're part of — open Seatwise to see it."
  );
});

// TS-178: nor as a phone number, and never more than one line.
test("a notification that could read as a phone number isn't emailed as written, and text is kept to one line", () => {
  const neutral = "There's an update on a wedding you're part of — open Seatwise to see it.";
  for (const v of ["Call 800, 555, 1234 is coming.", "Ana (800) 555-1234 declined.", "Ana is coming. Seated at evil. com"]) {
    assert.equal(emailSafeNotificationText(v), neutral, v);
  }
  assert.equal(emailSafeNotificationText("Ana Ruiz\n\nURGENT: reply now\r\nis coming."), "Ana Ruiz URGENT: reply now is coming.");
  assert.equal(emailSafeNotificationText(`Ana${String.fromCodePoint(0x202e)} Ruiz\tis coming.${String.fromCodePoint(0x2028)}`), "Ana Ruiz is coming.");
  assert.equal(emailSafeNotificationText("Ana Ruiz is coming. Seated at Table 12."), "Ana Ruiz is coming. Seated at Table 12.");
});

test("a copy's default name keeps to the wedding-name rules, length included", () => {
  assert.equal(copiedWeddingName("Ana & Bo's Wedding"), "Ana & Bo's Wedding - copy");
  assert.equal(emailSafeWeddingName(copiedWeddingName("Ana & Bo's Wedding")), "Ana & Bo's Wedding - copy");
  const long = copiedWeddingName("A".repeat(200));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith(" - copy"));
});

// TS-171: emails to people outside the wedding have a fixed subject, and the wedding's name only
// appears in the body, quoted as a name.
test("RSVP and invite emails have fixed subjects whatever the wedding is called", async () => {
  const { rsvpEmailText, inviteEmailText, RSVP_EMAIL_SUBJECT, INVITE_EMAIL_SUBJECT } = await import("./outgoing-email-text");
  for (const weddingName of ["Ana & Bo's Wedding", "Your account is suspended! Act now", "Call 1 800 555 0199 now!"]) {
    const rsvp = rsvpEmailText({ guestFirstName: "Ana", weddingName, url: "https://x.example/rsvp/abc", rsvpCutoffDate: null });
    assert.equal(rsvp.subject, RSVP_EMAIL_SUBJECT);
    assert.equal(rsvp.subject.includes(weddingName), false);
    const invite = inviteEmailText({ inviterName: "Bo", weddingName, roleLabel: "a collaborator", permissionLevel: "EDIT", acceptUrl: "https://x.example/invites/abc", expiresInDays: 7 });
    assert.equal(invite.subject, INVITE_EMAIL_SUBJECT);
  }
});

test("in the body, a wedding's name is quoted as a name -- or left out if it fails today's rules", async () => {
  const { rsvpEmailText, inviteEmailText } = await import("./outgoing-email-text");
  const rsvp = rsvpEmailText({ guestFirstName: "Ana", weddingName: "Ana & Bo's Wedding", url: "https://x.example/rsvp/abc", rsvpCutoffDate: "2027-05-01" });
  assert.match(rsvp.text, /^Hi Ana,/);
  assert.match(rsvp.text, /RSVP for a wedding named “Ana & Bo's Wedding” on Seatwise/);
  assert.match(rsvp.text, /https:\/\/x\.example\/rsvp\/abc/);
  // TS-177: dates in emails are MM-DD-YYYY too.
  assert.match(rsvp.text, /Please respond by 05-01-2027\./);

  const phone = rsvpEmailText({ guestFirstName: "Ana", weddingName: "Call 1 800 555 0199 now!", url: "u", rsvpCutoffDate: null });
  assert.equal(phone.text.includes("0199"), false);
  assert.match(phone.text, /RSVP for a wedding on Seatwise/);

  const invite = inviteEmailText({ inviterName: "Bo Chen", weddingName: "Ana & Bo", roleLabel: "a collaborator", permissionLevel: "EDIT", acceptUrl: "https://x.example/invites/abc", expiresInDays: 7 });
  assert.match(invite.text, /^Bo Chen invited you to join a wedding named “Ana & Bo” on Seatwise as a collaborator with edit access\./);
});

test("a name given for a copy follows the same rules as any wedding name", () => {
  assert.equal(duplicateFromTemplate.safeParse({ name: "Ana and Bo, again" }).success, true);
  assert.equal(duplicateFromTemplate.safeParse({ name: "Account locked - sign in at evil.com" }).success, false);
  assert.equal(duplicateFromTemplate.safeParse({ name: "<script>" }).success, false);
  assert.equal(duplicateFromTemplate.safeParse({}).success, true);
});

// TS-177: what the RSVP and invite emails promise matches what the links really do.
test("the RSVP email says answers can change only while RSVPs are open; the invite says how to accept and for how long", async () => {
  const { rsvpEmailText, inviteEmailText } = await import("./outgoing-email-text");
  const withCutoff = rsvpEmailText({ guestFirstName: "Ana", weddingName: "Ana & Bo", url: "u", rsvpCutoffDate: "2027-05-01" }).text;
  assert.match(withCutoff, /Please respond by 05-01-2027\. You can use this same link to see or change your answer until then\./);
  assert.doesNotMatch(withCutoff, /any time/);
  const noCutoff = rsvpEmailText({ guestFirstName: "Ana", weddingName: "Ana & Bo", url: "u", rsvpCutoffDate: null }).text;
  assert.match(noCutoff, /see or change your answer while RSVPs are open\./);
  const invite = inviteEmailText({ inviterName: "Bo Chen", weddingName: "Ana & Bo", roleLabel: "a collaborator", permissionLevel: "EDIT", acceptUrl: "u", expiresInDays: 9 }).text;
  assert.match(invite, /sign in or create a Seatwise account with this email address/);
  assert.match(invite, /works for 9 days, unless Bo Chen cancels it or sends a new invite/);
});
