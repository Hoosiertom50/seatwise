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
