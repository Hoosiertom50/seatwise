/**
 * TS-155 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — a session that should be over stays over.
 * - Resetting the password ends every other session of that account; the person who reset stays
 *   signed in.
 * - Logging out ends that session, including a copy of its token used directly -- and (TS-204,
 *   Tom's decision) only that one: another browser stays signed in. "Log out on all devices"
 *   ends every session.
 * - Many wrong passwords sent at once still only get the 10 allowed tries.
 * - The password check for deleting an account counts toward the same limit.
 * - Another site can't sign someone in or out with a form post (non-JSON or cross-site writes
 *   are refused).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";
import { plantPasswordResetToken } from "../support/testDatabase.js";

const COOKIE = "seatwise_token";

defineQualityTest(
  {
    id: "auth.sessions-end-on-reset-and-log-out.reset-logout-parallel-limit-cross-site",
    title: "a password reset or 'log out on all devices' ends other sessions, log out ends only this one, parallel wrong passwords stay capped, and cross-site or non-JSON writes are refused",
    objective:
      "Confirms that after a password reset another browser signed into the same account is signed out while the resetting browser stays in; that logging out makes the old token useless both as a cookie and as a Bearer token while another browser stays signed in, and that 'log out on all devices' signs that other browser out too; that 25 simultaneous wrong-password sign-ins for one account produce at most 10 password checks (the rest 429); that wrong passwords on account deletion hit the same limit; and that a plain-text (form-style) or cross-site sign-in request is refused before it can set a cookie.",
    expectedOutcome:
      "Browser B gets 401 from /auth/me after A resets the password, and A still gets 200. After logout the saved token gets 401 as cookie and as Bearer, while B still gets 200; after 'log out on all devices' B gets 401. Exactly 10 of 25 parallel attempts return 401 and 15 return 429. The 11th wrong deletion password returns 429. A text/plain sign-in returns 415 and a cross-site one 403, with no session cookie set.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:authentication", "@risk:critical", "@suite:regression"],
  },
  async ({ browser, playwright, baseURL }, testInfo) => {
    test.setTimeout(90_000);
    // Each part uses its own made-up network address, so the per-address sign-in limit never
    // carries over between runs or parts.
    const address = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;
    const newAccount = async () => {
      const token = uniqueToken(testInfo.workerIndex);
      const email = `pw-tester-sess-${token}@example.invalid`;
      const password = randomBytes(16).toString("base64url");
      const api = await playwright.request.newContext({ baseURL });
      expect((await api.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password } })).status()).toBe(201);
      await api.dispose();
      return { email, password };
    };
    const signedIn = async (email: string, password: string) => {
      const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": address() } });
      expect((await ctx.request.post("/api/v1/auth/login", { data: { email, password } })).status()).toBe(200);
      return ctx;
    };

    await test.step("A password reset signs every other browser out; the one that reset stays in", async () => {
      const { email, password } = await newAccount();
      const a = await signedIn(email, password);
      const b = await signedIn(email, password);
      try {
        expect((await b.request.get("/api/v1/auth/me")).status()).toBe(200);
        const resetToken = await plantPasswordResetToken(email);
        const reset = await a.request.post(`/api/v1/auth/reset-password/${resetToken}`, {
          data: { password: randomBytes(16).toString("base64url") },
        });
        expect(reset.status()).toBe(200);
        expect((await b.request.get("/api/v1/auth/me")).status()).toBe(401);
        expect((await a.request.get("/api/v1/auth/me")).status()).toBe(200);
      } finally {
        await a.close();
        await b.close();
      }
    });

    await test.step("Logging out ends this session -- even a saved copy of its token -- and only this one", async () => {
      const { email, password } = await newAccount();
      const a = await signedIn(email, password);
      const b = await signedIn(email, password);
      try {
        const saved = (await a.cookies()).find((c) => c.name === COOKIE)!.value;
        expect((await a.request.post("/api/v1/auth/logout", { data: {} })).status()).toBe(200);
        // TS-204 (Tom's decision): the other browser stays signed in.
        expect((await b.request.get("/api/v1/auth/me")).status()).toBe(200);
        const api = await playwright.request.newContext({ baseURL });
        try {
          expect((await api.get("/api/v1/auth/me", { headers: { authorization: `Bearer ${saved}` } })).status()).toBe(401);
          expect((await api.get("/api/v1/auth/me", { headers: { cookie: `${COOKIE}=${saved}` } })).status()).toBe(401);
        } finally {
          await api.dispose();
        }
        // Signing in again works as normal.
        const again = await signedIn(email, password);
        expect((await again.request.get("/api/v1/auth/me")).status()).toBe(200);
        await again.close();
      } finally {
        await a.close();
        await b.close();
      }
    });

    await test.step("TS-204: 'Log out on all devices' ends every session of the account", async () => {
      const { email, password } = await newAccount();
      const a = await signedIn(email, password);
      const b = await signedIn(email, password);
      try {
        const savedB = (await b.cookies()).find((c) => c.name === COOKIE)!.value;
        const res = await a.request.post("/api/v1/auth/logout", { data: { everywhere: true } });
        expect(res.status()).toBe(200);
        expect((await b.request.get("/api/v1/auth/me")).status()).toBe(401);
        expect((await a.request.get("/api/v1/auth/me")).status()).toBe(401);
        const api = await playwright.request.newContext({ baseURL });
        try {
          expect((await api.get("/api/v1/auth/me", { headers: { authorization: `Bearer ${savedB}` } })).status()).toBe(401);
        } finally {
          await api.dispose();
        }
      } finally {
        await a.close();
        await b.close();
      }
    });

    await test.step("25 wrong passwords sent at once still only get 10 tries", async () => {
      const { email } = await newAccount();
      // TS-171: from one address -- the 10-try limit is per account *from each address* (with a much
      // higher limit across all addresses), so a stranger elsewhere can't lock the owner out.
      const from = address();
      const statuses = await Promise.all(
        Array.from({ length: 25 }, async () => {
          const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": from } });
          try {
            return (await api.post("/api/v1/auth/login", { data: { email, password: `wrong-${randomUUID()}` } })).status();
          } finally {
            await api.dispose();
          }
        }),
      );
      expect(statuses.filter((s) => s === 401)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    });

    await test.step("Wrong passwords on 'delete my account' count toward the same limit", async () => {
      const { email, password } = await newAccount();
      const a = await signedIn(email, password);
      try {
        for (let i = 1; i <= 10; i++) {
          expect((await a.request.delete("/api/v1/auth/me", { data: { password: `wrong-${i}` } })).status(), `try ${i}`).toBe(403);
        }
        expect((await a.request.delete("/api/v1/auth/me", { data: { password: "wrong-11" } })).status()).toBe(429);
      } finally {
        await a.close();
      }
    });

    await test.step("A form-style or cross-site sign-in is refused and sets no cookie", async () => {
      const { email, password } = await newAccount();
      const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": address() } });
      try {
        const plain = await ctx.request.post("/api/v1/auth/login", {
          headers: { "content-type": "text/plain" },
          data: JSON.stringify({ email, password }),
        });
        expect(plain.status()).toBe(415);
        const crossSite = await ctx.request.post("/api/v1/auth/login", {
          headers: { "sec-fetch-site": "cross-site" },
          data: { email, password },
        });
        expect(crossSite.status()).toBe(403);
        expect((await ctx.cookies()).some((c) => c.name === COOKIE && c.value)).toBe(false);
        const formLogout = await ctx.request.post("/api/v1/auth/logout", { form: { a: "b" } });
        expect(formLogout.status()).toBe(415);
      } finally {
        await ctx.close();
      }
    });
  },
);
