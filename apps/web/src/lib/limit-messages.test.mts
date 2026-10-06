// TS-177: unit tests for the words shown when a limit refuses something, the import's "Side"
// column, and the invitations/people count. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emailLimitReason, emailSendRefusedMessage, tooManyAttemptsMessage } from "./limit-messages";
import { parseGuestSide } from "../../../../packages/shared/src/guest-side";
import { formatGuestCounts } from "../../../../packages/shared/src/guest-counts";

test("the generic 'too many' message follows how long the limit lasts", () => {
  assert.match(tooManyAttemptsMessage(600), /wait a few minutes/);
  assert.match(tooManyAttemptsMessage(900), /wait a few minutes/);
  assert.match(tooManyAttemptsMessage(3600), /in about an hour/);
  assert.equal(tooManyAttemptsMessage(86_400), "You've reached today's limit for this — please try again tomorrow.");
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
  assert.equal(emailLimitReason([{ windowSeconds: 3600, accountDaily: false }]), "short");

  assert.equal(
    emailSendRefusedMessage("invites", "account-day"),
    "You've reached today's email limit for your account — you can send more tomorrow."
  );
  assert.match(emailSendRefusedMessage("invites", "short"), /a lot of invites in a short time/);
  assert.match(emailSendRefusedMessage("invites", "day"), /today's limit for invites/);
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

test("guest counts show invitations and people, singular and plural", () => {
  assert.equal(formatGuestCounts(12, 30), "12 invitations · 30 people");
  assert.equal(formatGuestCounts(1, 1), "1 invitation · 1 person");
  assert.equal(formatGuestCounts(0, 0), "0 invitations · 0 people");
  assert.equal(formatGuestCounts(1, 2), "1 invitation · 2 people");
});
