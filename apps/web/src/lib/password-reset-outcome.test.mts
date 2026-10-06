// TS-145: unit tests for what "Forgot password?" tells the person. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetOutcome, RESET_EMAIL_FAILED_MESSAGE, RESET_NO_ACCOUNT_MESSAGE, RESET_SENT_MESSAGE } from "./password-reset-outcome";

test("an email with no account is told so, whatever happened with email", () => {
  assert.deepEqual(resetOutcome(false, null), { sent: false, noAccount: true, message: RESET_NO_ACCOUNT_MESSAGE });
});

test("only a delivered (or, locally and in CI, logged) email is reported as sent", () => {
  assert.deepEqual(resetOutcome(true, "sent"), { sent: true, message: RESET_SENT_MESSAGE });
  assert.deepEqual(resetOutcome(true, "logged"), { sent: true, message: RESET_SENT_MESSAGE });
});

test("a failed or unconfigured email says it couldn't be sent -- never 'we've sent a link'", () => {
  for (const result of ["failed", "not-configured"] as const) {
    assert.deepEqual(resetOutcome(true, result), { sent: false, emailFailed: true, message: RESET_EMAIL_FAILED_MESSAGE });
  }
});

// TS-177
test("asking again while a link still works says it was already sent; a used-up day says tomorrow", async () => {
  const { RESET_ALREADY_SENT_MESSAGE, RESET_EMAIL_LIMITED_MESSAGE } = await import("./password-reset-outcome");
  assert.deepEqual(resetOutcome(true, "already-sent"), { sent: true, alreadySent: true, message: RESET_ALREADY_SENT_MESSAGE });
  assert.match(RESET_ALREADY_SENT_MESSAGE, /already sent you a link/);
  assert.deepEqual(resetOutcome(true, "limited"), { sent: false, emailFailed: true, message: RESET_EMAIL_LIMITED_MESSAGE });
  assert.match(RESET_EMAIL_LIMITED_MESSAGE, /try again tomorrow/);
});

// TS-186: an address that has had its emails for today is told that -- not that Seatwise has stopped.
test("an address at its own daily limit is told it's that address, and to try tomorrow", async () => {
  const { RESET_RECIPIENT_LIMITED_MESSAGE, RESET_EMAIL_LIMITED_MESSAGE } = await import("./password-reset-outcome");
  assert.deepEqual(resetOutcome(true, "recipient-limited"), { sent: false, emailFailed: true, message: RESET_RECIPIENT_LIMITED_MESSAGE });
  assert.notEqual(RESET_RECIPIENT_LIMITED_MESSAGE, RESET_EMAIL_LIMITED_MESSAGE);
  assert.match(RESET_RECIPIENT_LIMITED_MESSAGE, /This email address has had as many emails from Seatwise as it can today/);
  assert.match(RESET_RECIPIENT_LIMITED_MESSAGE, /try again tomorrow/);
});
