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

test("a failed or unconfigured email says it couldn't be sent -- never 'we've sent a link'", async () => {
  assert.deepEqual(resetOutcome(true, "failed"), { sent: false, emailFailed: true, message: RESET_EMAIL_FAILED_MESSAGE });
  // TS-194: no email service set up has its own words -- "try again in a few minutes" wouldn't help.
  const { RESET_EMAIL_NOT_SET_UP_MESSAGE } = await import("./password-reset-outcome");
  assert.deepEqual(resetOutcome(true, "not-configured"), { sent: false, emailFailed: true, message: RESET_EMAIL_NOT_SET_UP_MESSAGE });
  assert.doesNotMatch(RESET_EMAIL_NOT_SET_UP_MESSAGE, /few minutes/);
});

// TS-177
test("asking again while a link still works says it was already sent; a used-up allowance says within a day", async () => {
  const { RESET_ALREADY_SENT_MESSAGE, RESET_EMAIL_LIMITED_MESSAGE } = await import("./password-reset-outcome");
  assert.deepEqual(resetOutcome(true, "already-sent"), { sent: true, alreadySent: true, message: RESET_ALREADY_SENT_MESSAGE });
  assert.match(RESET_ALREADY_SENT_MESSAGE, /already sent you a link/);
  assert.deepEqual(resetOutcome(true, "limited"), { sent: false, emailFailed: true, message: RESET_EMAIL_LIMITED_MESSAGE });
  // TS-194: Seatwise's allowance rolls over 24 hours, so not "tomorrow". TS-203: and after a burst
  // it can take up to a day, so not "a few hours" either.
  assert.match(RESET_EMAIL_LIMITED_MESSAGE, /within about a day/);
  assert.doesNotMatch(RESET_EMAIL_LIMITED_MESSAGE, /tomorrow|today|few hours/);
});

// TS-186: an address that has had its emails is told that -- not that Seatwise has stopped.
test("an address at its own limit is told it's that address, over the last 24 hours", async () => {
  const { RESET_RECIPIENT_LIMITED_MESSAGE, RESET_EMAIL_LIMITED_MESSAGE } = await import("./password-reset-outcome");
  assert.deepEqual(resetOutcome(true, "recipient-limited"), { sent: false, emailFailed: true, message: RESET_RECIPIENT_LIMITED_MESSAGE });
  assert.notEqual(RESET_RECIPIENT_LIMITED_MESSAGE, RESET_EMAIL_LIMITED_MESSAGE);
  // TS-203: the count rolls over 24 hours -- "today"/"tomorrow" meant midnight UTC.
  assert.match(RESET_RECIPIENT_LIMITED_MESSAGE, /This email address has had as many emails from Seatwise as it can in the last 24 hours/);
  assert.match(RESET_RECIPIENT_LIMITED_MESSAGE, /within about a day/);
  assert.doesNotMatch(RESET_RECIPIENT_LIMITED_MESSAGE, /tomorrow|today/);
});

// TS-203: the mail server went quiet after it may have taken the email -- the link may well arrive.
test("a reset that may have gone out says so, and that its link works for an hour", async () => {
  const { RESET_MAYBE_SENT_MESSAGE } = await import("./password-reset-outcome");
  assert.deepEqual(resetOutcome(true, "uncertain"), { sent: true, uncertain: true, message: RESET_MAYBE_SENT_MESSAGE });
  assert.match(RESET_MAYBE_SENT_MESSAGE, /may have sent you a link/);
  assert.match(RESET_MAYBE_SENT_MESSAGE, /1 hour/);
});
