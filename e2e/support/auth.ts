/**
 * Stage 03 — authentication-state fixture logic (spec Stage 03 task: "Implement
 * authentication-state fixtures without embedding credentials").
 *
 * Signs up a brand-new account per test through the real signup API. The app authenticates via an
 * httpOnly cookie set directly by the server's Set-Cookie response header (see
 * apps/web/src/lib/api-client.ts's `credentials: "include"`), so calling this through an
 * `APIRequestContext` that shares a cookie jar with the `BrowserContext` a test's `page` belongs
 * to is enough — no token is ever read, stored, or injected into `localStorage`/`document.cookie`
 * by this framework. The generated password is used exactly once, for this one signup call, and
 * is never returned, logged, or attached to any evidence: nothing downstream can leak a credential
 * this module never keeps.
 */

import type { APIRequestContext, Browser, BrowserContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { uniqueTestAddress, uniqueToken } from "../data/ids.js";
import { getEnv } from "./env.js";
import { resolveIsProduction } from "./productionGuard.js";

/**
 * TS-74: every test that touches the app starts by signing up a throwaway account -- even the
 * @readonly ones, whose *action under test* only reads. Against production that would leave test
 * accounts (and whatever the test arranges next) in real data, and the teardown sweep rightly
 * refuses to delete anything there. So account creation refuses outright on a production host,
 * with or without --allow-production: no test can write its setup into production.
 */
function refuseTestAccountsOnProduction(): void {
  const env = getEnv();
  if (resolveIsProduction(env.APP_URL, env.PRODUCTION_HOSTNAMES)) {
    throw new Error(
      `Refusing to create a test account on "${new URL(env.APP_URL).hostname}": it's a production host. ` +
        `Test setup must never write to real data -- check the live site by hand instead (see TS-75).`,
    );
  }
}

export interface SignedUpAccount {
  name: string;
  email: string;
}

/**
 * TS-103: the domain every account this framework signs up belongs to, and the single predicate
 * run-level cleanup uses to decide an account is test-created and may be purged.
 *
 * `.invalid` is the IANA-reserved TLD that is guaranteed never to resolve or receive mail
 * (RFC 2606). That makes it a far stronger safety property than a naming convention: a real user
 * account cannot have an address in this domain, because the domain cannot exist. The purge is
 * therefore structurally incapable of matching a genuine account, rather than relying on care.
 *
 * This matters more here than for weddings or templates: `User` is the root of the cascade --
 * `SeatingTemplate.ownerId` is `onDelete: Cascade` (TS-187: `Wedding.ownerId` is now `Restrict`, so
 * the run-level purge deletes a test account's weddings itself, just before the account) -- so
 * deleting the wrong user destroys their weddings, guests, plans and templates along with them.
 */
export const TEST_ACCOUNT_EMAIL_DOMAIN = "@example.invalid";

/** True when `email` belongs to an account this framework created. The one predicate the user
 * purge matches on. */
export function isTestAccountEmail(email: string): boolean {
  return email.toLowerCase().endsWith(TEST_ACCOUNT_EMAIL_DOMAIN);
}

function generateEphemeralPassword(): string {
  // 16 random bytes, base64url-encoded: well over the app's 8-character minimum, unique per call,
  // and never persisted anywhere by this module once the signup request returns.
  return randomBytes(16).toString("base64url");
}

/**
 * Signs up and authenticates a fresh, worker-safe account. `request` must be the request context
 * belonging to the same `BrowserContext` as the page(s) that need to be logged in (Playwright's
 * default fixtures already wire `page.request`/`context.request` this way).
 */
export async function signUpFreshAccount(
  request: APIRequestContext,
  workerIndex: number,
  { confirmEmail = true }: { confirmEmail?: boolean } = {},
): Promise<SignedUpAccount> {
  refuseTestAccountsOnProduction();
  const token = uniqueToken(workerIndex);
  const name = `Playwright Tester ${token}`;
  // `.invalid` is the IANA-reserved TLD guaranteed to never resolve or deliver (RFC 2606) — the
  // right choice here: sign-up sends a confirmation email (TS-164), and this address must never
  // reach a real inbox.
  const email = `pw-tester-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
  const password = generateEphemeralPassword();

  const res = await request.post("/api/v1/auth/signup", { data: { name, email, password } });
  if (!res.ok()) {
    throw new Error(`signUpFreshAccount failed: HTTP ${res.status()} — ${await res.text()}`);
  }
  // TS-164: confirmed as if the emailed link had been clicked (see confirmTestAccountEmail).
  if (confirmEmail) await (await import("./testDatabase.js")).confirmTestAccountEmail(email);
  return { name, email };
}

export interface SignedUpBrowserSession extends SignedUpAccount {
  context: BrowserContext;
}

/**
 * TS-43 (REQ-PLAN-REVIEW-STATUS): like `signUpFreshAccount`, but for tests that need a *second*
 * real, UI-driven, distinctly-permissioned user (e.g. confirming a View-only collaborator's
 * browser genuinely never renders an Approve button or a comment compose form) rather than just a
 * second API identity.
 *
 * Opens a brand-new `BrowserContext` (its own independent cookie jar -- entirely separate from
 * whatever account the test's own `page`/`context` fixture is signed in as) and signs up through
 * that context's own `request`. The server's Set-Cookie lands in that same context's cookie jar,
 * so any `page` opened from `context` afterward is already authenticated -- no separate login step
 * (and no need to ever know or pass around the generated password) is required. Same password
 * discipline as `signUpFreshAccount`: generated once, used once, never returned.
 *
 * Callers own the returned context's lifecycle -- close it (`await session.context.close()`) when
 * done, same as any other `browser.newContext()`.
 */
export async function signUpFreshAccountInNewContext(
  browser: Browser,
  workerIndex: number,
  label = "",
  { confirmEmail = true }: { confirmEmail?: boolean } = {},
): Promise<SignedUpBrowserSession> {
  refuseTestAccountsOnProduction();
  // TS-163: its own made-up address, like every test (see uniqueTestAddress).
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
  const token = uniqueToken(workerIndex);
  // TS-156: a display name may only hold letters (and spaces, ' . -), so any digits in a label like "comment2"
  // are dropped from the name; the email keeps the label as-is.
  const nameLabel = label.replace(/[^\p{L} ]/gu, "");
  const name = `Playwright Tester ${nameLabel ? `${nameLabel} ` : ""}${token}`;
  const email = `pw-tester-${label ? `${label}-` : ""}${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
  const password = generateEphemeralPassword();

  const res = await context.request.post("/api/v1/auth/signup", { data: { name, email, password } });
  if (!res.ok()) {
    await context.close();
    throw new Error(`signUpFreshAccountInNewContext failed: HTTP ${res.status()} — ${await res.text()}`);
  }
  // TS-164: confirmed as if the emailed link had been clicked (see confirmTestAccountEmail).
  if (confirmEmail) await (await import("./testDatabase.js")).confirmTestAccountEmail(email);
  return { name, email, context };
}
