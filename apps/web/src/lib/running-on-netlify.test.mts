// TS-200: unit tests for the one "is this running on Netlify?" check (packages/shared/src/netlify.ts),
// and for what uses it: the app's address, the test-only direct add, and the email "log" transport,
// which is refused on Netlify so a planner is never told "Emailed" when nothing was sent. Run with
// `pnpm --filter @seatwise/web test`. Nothing here sends an email or touches a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runningOnNetlify } from "../../../../packages/shared/src/netlify";
import { appBaseUrl, AppUrlNotConfiguredError } from "./app-url";
import { directCollaboratorAddAllowed } from "./direct-add";

const { sendEmail, setEmailSenderForTests } = await import("@seatwise/db");

const NETLIFY_ENVS = [
  { NETLIFY: "true" },
  { CONTEXT: "production" },
  { CONTEXT: "deploy-preview" },
  { SITE_ID: "abc" },
  { DEPLOY_ID: "123" },
  { URL: "https://seatwise-app.netlify.app" },
  { URL: "https://deploy-preview-12--seatwise-app.netlify.app" },
];

test("each of Netlify's variables means running on Netlify", () => {
  for (const env of NETLIFY_ENVS) assert.equal(runningOnNetlify(env), true, JSON.stringify(env));
});

test("this machine, CI and `netlify dev` aren't Netlify", () => {
  assert.equal(runningOnNetlify({}), false);
  assert.equal(runningOnNetlify({ NODE_ENV: "production", CI: "true", EMAIL_TRANSPORT: "log" }), false);
  // URL is a common name: only a Netlify address counts on its own.
  assert.equal(runningOnNetlify({ URL: "http://localhost:3000" }), false);
  assert.equal(runningOnNetlify({ URL: "https://example.com" }), false);
  assert.equal(runningOnNetlify({ URL: "https://netlify.app.example.com" }), false);
  assert.equal(runningOnNetlify({ URL: "not a web address" }), false);
  assert.equal(runningOnNetlify({ NETLIFY_DEV: "true", NETLIFY: "true", CONTEXT: "dev", SITE_ID: "abc", URL: "https://seatwise-app.netlify.app" }), false);
});

test("the app's address and the direct add agree with it", () => {
  for (const env of NETLIFY_ENVS) {
    assert.throws(() => appBaseUrl({ ...env, NODE_ENV: "production", EMAIL_TRANSPORT: "log" }), AppUrlNotConfiguredError, JSON.stringify(env));
    assert.equal(directCollaboratorAddAllowed({ ...env, NODE_ENV: "development" }), false, JSON.stringify(env));
  }
  assert.equal(appBaseUrl({ NODE_ENV: "development", NETLIFY_DEV: "true", NETLIFY: "true" }), "http://localhost:3000");
  // TS-204: the direct add uses the stricter check -- `netlify dev` switches it off too.
  assert.equal(directCollaboratorAddAllowed({ NODE_ENV: "development", NETLIFY_DEV: "true", NETLIFY: "true" }), false);
});

test("on Netlify, an email that would only be printed is refused as failed, with a clear error", async () => {
  let sent = 0;
  setEmailSenderForTests(async () => {
    sent++;
  });
  const errors: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  console.log = () => {};
  try {
    for (const env of [
      { EMAIL_TRANSPORT: "log", NODE_ENV: "production", SITE_ID: "abc" },
      // A build that isn't a production one prints email by default -- not on Netlify either.
      { NODE_ENV: "development", NETLIFY: "true" },
      // An explicit "log" wins over credentials, so it's refused even with them.
      { EMAIL_TRANSPORT: "log", NODE_ENV: "production", DEPLOY_ID: "1", SMTP_USER: "u@example.invalid", SMTP_PASSWORD: "p" },
    ]) {
      errors.length = 0;
      const result = await sendEmail("guest@example.invalid", "Your RSVP link", "https://seatwise-app.netlify.app/rsvp/abc", env);
      assert.equal(result, "failed", JSON.stringify(env));
      assert.equal(errors.length, 1, JSON.stringify(env));
      assert.match(errors[0], /NOT sent to .*never happens on Netlify/);
      assert.doesNotMatch(errors[0], /guest@example\.invalid/, "the address is masked");
    }
    assert.equal(sent, 0);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    setEmailSenderForTests();
  }
});
