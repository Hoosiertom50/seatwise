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
