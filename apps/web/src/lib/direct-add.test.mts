// TS-148: unit tests for when direct collaborator adds are allowed. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { directCollaboratorAddAllowed } from "./direct-add";

test("the live site (production build, no flag) refuses direct adds", () => {
  assert.equal(directCollaboratorAddAllowed({ NODE_ENV: "production" }), false);
  assert.equal(directCollaboratorAddAllowed({ NODE_ENV: "production", ALLOW_DIRECT_COLLABORATOR_ADD: "true" }), false);
});

test("local development and CI (with the flag) allow them for test setup", () => {
  assert.equal(directCollaboratorAddAllowed({ NODE_ENV: "development" }), true);
  assert.equal(directCollaboratorAddAllowed({ NODE_ENV: "production", ALLOW_DIRECT_COLLABORATOR_ADD: "1" }), true);
});

test("TS-183: never on Netlify, whatever else is set", () => {
  assert.equal(directCollaboratorAddAllowed({ NODE_ENV: "production", ALLOW_DIRECT_COLLABORATOR_ADD: "1", NETLIFY: "true" }), false);
  assert.equal(directCollaboratorAddAllowed({ NODE_ENV: "development", NETLIFY: "true" }), false);
});

test("TS-192: never when Netlify's runtime variables are set, even without NETLIFY", () => {
  for (const runtime of [{ SITE_ID: "abc" }, { DEPLOY_ID: "123" }, { URL: "https://seatwise-app.netlify.app" }]) {
    assert.equal(directCollaboratorAddAllowed({ NODE_ENV: "production", ALLOW_DIRECT_COLLABORATOR_ADD: "1", ...runtime }), false, JSON.stringify(runtime));
    assert.equal(directCollaboratorAddAllowed({ NODE_ENV: "development", ...runtime }), false, JSON.stringify(runtime));
  }
});

test("TS-204: the strict check -- URL set to anything, or netlify dev, switches it off", () => {
  for (const extra of [
    { URL: "https://example.com" },
    { URL: "http://localhost:3000" },
    { URL: "anything" },
    { NETLIFY_DEV: "true" },
    { NETLIFY_DEV: "true", NETLIFY: "true" },
    { CONTEXT: "dev" },
  ]) {
    assert.equal(directCollaboratorAddAllowed({ NODE_ENV: "development", ...extra }), false, JSON.stringify(extra));
    assert.equal(
      directCollaboratorAddAllowed({ NODE_ENV: "production", ALLOW_DIRECT_COLLABORATOR_ADD: "1", ...extra }),
      false,
      JSON.stringify(extra)
    );
  }
  // CI's own setup (no URL, no Netlify variables) still allows it.
  assert.equal(
    directCollaboratorAddAllowed({ NODE_ENV: "production", ALLOW_DIRECT_COLLABORATOR_ADD: "1", APP_URL: "http://localhost:3000", CI: "true" }),
    true
  );
});
