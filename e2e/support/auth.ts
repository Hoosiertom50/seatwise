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

import type { APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { uniqueToken } from "../data/ids.js";

export interface SignedUpAccount {
  name: string;
  email: string;
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
  const email = `pw-tester-${token}@example.invalid`;
  const password = generateEphemeralPassword();

  const res = await request.post("/api/v1/auth/signup", { data: { name, email, password } });
  if (!res.ok()) {
    throw new Error(`signUpFreshAccount failed: HTTP ${res.status()} — ${await res.text()}`);
  }
  return { name, email };
}
