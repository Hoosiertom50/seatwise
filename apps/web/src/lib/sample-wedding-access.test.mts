// TS-272: unit tests for who may use "Add a sample wedding". Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mayAddSampleWedding, sampleWeddingDomains } from "./sample-wedding-access";

const confirmed = new Date("2026-10-16T12:00:00Z");
const on = { SAMPLE_WEDDING_EMAIL_DOMAINS: "team.example" };

test("off for everyone when the setting is missing or blank", () => {
  for (const env of [{}, { SAMPLE_WEDDING_EMAIL_DOMAINS: "" }, { SAMPLE_WEDDING_EMAIL_DOMAINS: " , " }]) {
    assert.equal(mayAddSampleWedding({ email: "pat@team.example", emailVerifiedAt: confirmed }, env), false, JSON.stringify(env));
  }
});

test("a confirmed account on the domain may, whatever the case", () => {
  assert.equal(mayAddSampleWedding({ email: "pat@team.example", emailVerifiedAt: confirmed }, on), true);
  assert.equal(mayAddSampleWedding({ email: "Pat@TEAM.Example", emailVerifiedAt: confirmed }, on), true);
  assert.equal(mayAddSampleWedding({ email: "pat@team.example", emailVerifiedAt: confirmed }, { SAMPLE_WEDDING_EMAIL_DOMAINS: " @Team.Example " }), true);
});

test("an account whose email isn't confirmed yet may not", () => {
  assert.equal(mayAddSampleWedding({ email: "pat@team.example", emailVerifiedAt: null }, on), false);
});

test("nobody signed in may not", () => {
  assert.equal(mayAddSampleWedding(null, on), false);
});

test("only the whole domain counts -- not a lookalike, a subdomain or a longer one", () => {
  for (const email of ["pat@other.example", "pat@evilteam.example", "pat@sub.team.example", "pat@team.example.evil", "team.example@other.example", "pat@team-example", "pat@", "@team.example"]) {
    assert.equal(mayAddSampleWedding({ email, emailVerifiedAt: confirmed }, on), false, email);
  }
});

test("several domains, comma-separated; an entry holding an @ is ignored", () => {
  const env = { SAMPLE_WEDDING_EMAIL_DOMAINS: "team.example, Partner.Example ,pat@x.example" };
  assert.deepEqual(sampleWeddingDomains(env), ["team.example", "partner.example"]);
  assert.equal(mayAddSampleWedding({ email: "lee@partner.example", emailVerifiedAt: confirmed }, env), true);
  assert.equal(mayAddSampleWedding({ email: "pat@x.example", emailVerifiedAt: confirmed }, env), false);
});
