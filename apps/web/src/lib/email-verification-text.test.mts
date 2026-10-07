// TS-177: unit tests for the words about confirming an email address (email-verification-text.ts).
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmEmailFirstMessage, confirmEmailToAcceptMessage, verificationEmailBody } from "./email-verification-text";

test("the confirmation email says what waits on confirming, notifications included", () => {
  const body = verificationEmailBody({ link: "https://seatwise.example/verify-email/abc", hours: 48 });
  // TS-178: no name in the greeting -- whoever signed up typed it, and may not own the address.
  assert.match(body, /^Hi,\n/);
  assert.match(body, /https:\/\/seatwise\.example\/verify-email\/abc/);
  assert.match(body, /works for 48 hours/);
  assert.match(body, /won't send invites or RSVP emails from your account, or email you notifications\./);
});

test("the confirm-first messages never claim a link was sent", () => {
  for (const message of [confirmEmailFirstMessage(), confirmEmailToAcceptMessage()]) {
    assert.doesNotMatch(message, /we sent/i);
    assert.match(message, /use the link we email you, or "Resend link" at the top of the page if it hasn't arrived/);
  }
  assert.match(confirmEmailFirstMessage(), /^Confirm your email address first/);
  assert.match(confirmEmailToAcceptMessage(), /^Confirm your email address to accept this invite.*Then come back to this page\.$/);
});

test("Resend link says when it could work: within a day for the rolling allowances, minutes for a hiccup", async () => {
  const { emailNotSentMessage } = await import("./email-verification-text");
  // TS-194: Seatwise's own allowance rolls over 24 hours. TS-203: after a burst that can be up to a
  // day -- not "a few hours" -- and the address's count rolls too, so neither says today/tomorrow.
  for (const result of ["limited", "account-limited", "recipient-limited"] as const) {
    assert.match(emailNotSentMessage(result), /within about a day/, result);
    assert.doesNotMatch(emailNotSentMessage(result), /tomorrow|today|few hours/, result);
  }
  assert.match(emailNotSentMessage("recipient-limited"), /in the last 24 hours/);
  // TS-203: a send that may have gone out says so, and to check before asking again.
  assert.match(emailNotSentMessage("uncertain"), /may have sent/);
  assert.match(emailNotSentMessage("failed"), /in a few minutes/);
  // TS-194: no email service set up -- trying again won't help, so it doesn't say to.
  assert.match(emailNotSentMessage("not-configured"), /email isn't set up on this site/);
  assert.doesNotMatch(emailNotSentMessage("not-configured"), /few minutes/);
});
