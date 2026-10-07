// TS-177: unit tests for the words shown when a limit refuses something, the import's "Side"
// column, and the invitations/people count. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emailLimitReason, emailSendRefusedMessage, tooManyAttemptsMessage, tryAgainIn, TOO_MANY_WEDDINGS_TODAY } from "./limit-messages";
import { parseGuestSide } from "../../../../packages/shared/src/guest-side";
import { formatGuestCounts } from "../../../../packages/shared/src/guest-counts";

test("the generic 'too many' message follows how long the limit lasts", () => {
  assert.match(tooManyAttemptsMessage(600), /wait a few minutes/);
  assert.match(tooManyAttemptsMessage(900), /wait a few minutes/);
  assert.match(tooManyAttemptsMessage(3600), /in about an hour/);
  // TS-203: a daily limit rolls over 24 hours -- it says so, and how long the wait really is.
  assert.equal(tooManyAttemptsMessage(86_400), "You've reached the limit for this in the last 24 hours — please try again within about a day.");
  assert.equal(
    tooManyAttemptsMessage(86_400, 5 * 3600 - 30),
    "You've reached the limit for this in the last 24 hours — please try again in about 5 hours."
  );
});

test("TS-203: the wait is put in words without 'today' or 'tomorrow'", () => {
  assert.equal(tryAgainIn(1), "in under an hour");
  assert.equal(tryAgainIn(3600), "in under an hour");
  assert.equal(tryAgainIn(3601), "in about 2 hours");
  assert.equal(tryAgainIn(23 * 3600), "in about 23 hours");
  assert.equal(tryAgainIn(25 * 3600), "in about a day");
  assert.equal(tryAgainIn(undefined), "within about a day");
  for (const message of [
    TOO_MANY_WEDDINGS_TODAY(7200),
    emailSendRefusedMessage("invites", "account-day", 7200),
    emailSendRefusedMessage("invites", "new-account-day", 7200),
    emailSendRefusedMessage("invites", "day", 7200),
    emailSendRefusedMessage("rsvpEmails", "day"),
  ]) {
    assert.doesNotMatch(message, /today|tomorrow/, message);
  }
  assert.equal(TOO_MANY_WEDDINGS_TODAY(7200), "You've created a lot of weddings in the last 24 hours — you can create more in about 2 hours.");
});

test("a refused email names the limit that actually refused it", () => {
  // Only the account's daily allowance is full.
  assert.equal(emailLimitReason([{ windowSeconds: 86_400, accountDaily: true }]), "account-day");
  // An hourly window and the daily allowance both full: it's still tomorrow.
  assert.equal(
    emailLimitReason([
      { windowSeconds: 3600, accountDaily: false },
      { windowSeconds: 86_400, accountDaily: true },
    ]),
    "account-day"
  );
  assert.equal(emailLimitReason([{ windowSeconds: 86_400, accountDaily: false }]), "day");
  // TS-194: a new account's smaller allowance says so.
  assert.equal(emailLimitReason([{ windowSeconds: 86_400, accountDaily: true, newAccount: true }]), "new-account-day");
  assert.match(emailSendRefusedMessage("rsvpEmails", "new-account-day"), /^New accounts can send up to 20 emails in any 24 hours during their first week/);
  assert.match(emailSendRefusedMessage("invites", "new-account-day", 3 * 3600), /in about 3 hours/);
  assert.equal(emailLimitReason([{ windowSeconds: 3600, accountDaily: false }]), "short");

  assert.equal(
    emailSendRefusedMessage("invites", "account-day"),
    "You've reached your account's email limit for the last 24 hours — you can send more within about a day."
  );
  assert.match(emailSendRefusedMessage("invites", "short"), /a lot of invites in a short time/);
  assert.match(emailSendRefusedMessage("invites", "day"), /the limit for invites in the last 24 hours/);
  assert.doesNotMatch(emailSendRefusedMessage("rsvpEmails", "short"), /invites/);
});

test("an import's Side accepts the wedding's own side names, Both, and Bride/Groom", () => {
  assert.deepEqual(parseGuestSide("Alex", "Alex", "Jordan"), { side: "BRIDE" });
  assert.deepEqual(parseGuestSide("  jordan ", "Alex", "Jordan"), { side: "GROOM" });
  assert.deepEqual(parseGuestSide("BOTH", "Alex", "Jordan"), { side: "BOTH" });
  assert.deepEqual(parseGuestSide("bride", "Alex", "Jordan"), { side: "BRIDE" });
  assert.deepEqual(parseGuestSide("Groom", "Alex", "Jordan"), { side: "GROOM" });
  assert.deepEqual(parseGuestSide("Sam", "Alex", "Jordan"), { error: `Side "Sam" isn't one of Alex, Jordan or Both.` });
  // A wedding whose first side is called "Groom" means its first side by it.
  assert.deepEqual(parseGuestSide("Groom", "Groom", "Bride"), { side: "BRIDE" });
});

test("guest counts show invitations and people invited, singular and plural", () => {
  // TS-214: "invited" -- declined and not-attending guests are in this number.
  assert.equal(formatGuestCounts(12, 30), "12 invitations · 30 people invited");
  assert.equal(formatGuestCounts(1, 1), "1 invitation · 1 person invited");
  assert.equal(formatGuestCounts(0, 0), "0 invitations · 0 people invited");
  assert.equal(formatGuestCounts(1, 2), "1 invitation · 2 people invited");
});
