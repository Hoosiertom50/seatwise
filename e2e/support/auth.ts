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
import { uniqueToken } from "../data/ids.js";

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
 * `Wedding.ownerId` and `SeatingTemplate.ownerId` are both `onDelete: Cascade` -- so deleting the
 * wrong user destroys their weddings, guests, plans and templates along with them.
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
): Promise<SignedUpAccount> {
  const token = uniqueToken(workerIndex);
  const name = `Playwright Tester ${token}`;
  // `.invalid` is the IANA-reserved TLD guaranteed to never resolve or deliver (RFC 2606) — the
  // right choice here since signup itself never sends a verification email and this address must
  // never accidentally reach a real inbox.
  const email = `pw-tester-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
  const password = generateEphemeralPassword();

  const res = await request.post("/api/v1/auth/signup", { data: { name, email, password } });
  if (!res.ok()) {
    throw new Error(`signUpFreshAccount failed: HTTP ${res.status()} — ${await res.text()}`);
  }
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
): Promise<SignedUpBrowserSession> {
  const context = await browser.newContext();
  const token = uniqueToken(workerIndex);
  const name = `Playwright Tester ${label ? `${label} ` : ""}${token}`;
  const email = `pw-tester-${label ? `${label}-` : ""}${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
  const password = generateEphemeralPassword();

  const res = await context.request.post("/api/v1/auth/signup", { data: { name, email, password } });
  if (!res.ok()) {
    await context.close();
    throw new Error(`signUpFreshAccountInNewContext failed: HTTP ${res.status()} — ${await res.text()}`);
  }
  return { name, email, context };
}
