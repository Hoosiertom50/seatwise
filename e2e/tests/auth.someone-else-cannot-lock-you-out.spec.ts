/**
 * TS-171 (REQ-ACCOUNT-WEDDING-MANAGEMENT, REQ-NON-FUNCTIONAL) — someone else can't keep a person
 * out of their own account.
 * - Wrong passwords lock the account only from the address they came from (10 per 15 minutes);
 *   the owner signing in from elsewhere still gets in. A much higher limit (100) on the account
 *   from everywhere together still stops guessing spread across many addresses.
 * - IPv6 visitors are limited by their /64 network, not each address in it.
 * - Asking for a password reset while the last link still works sends nothing new and cancels
 *   nothing, so repeated requests can't use up the person's resets or kill their link.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueTestAddress, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { usableResetTokenCount } from "../support/testDatabase.js";

const FAILURES_PER_ACCOUNT_AND_ADDRESS = 10;
const FAILURES_PER_ACCOUNT = 100;
const FAILURES_PER_ADDRESS = 30;

/** A /64 network from the IPv6 documentation range, different every run. */
function uniqueIpv6Network(): string {
  const group = () => Math.floor(Math.random() * 0xffff).toString(16);
  return `2001:db8:${group()}:${group()}`;
}

defineQualityTest(
  {
    id: "auth.someone-else-cannot-lock-you-out.sign-in-limits-and-reset-requests",
    title: "wrong passwords from one address don't lock the owner out elsewhere, IPv6 is limited per /64, and repeated reset requests don't use up or cancel a working link",
    objective:
      "Confirms that after 10 wrong passwords from one address the account is refused from that address (even with the right password) but the right password from another address signs in; that 100 wrong passwords spread over 10 addresses lock the account from an 11th address too; that 30 failed sign-ins from different addresses inside one IPv6 /64 block another address in that /64 but not one in a different /64; and that six password-reset requests for one account in a row all say a link was sent while only one link ever exists and the per-email limit (3 per 15 minutes) never refuses them.",
    expectedOutcome:
      "Failures 1–10 from address A return 401; the right password from A returns 429 and from B returns 200. 100 failures over 10 addresses return 401; the right password from an 11th address returns 429. 30 failures within one /64 return 401; the 31st from another address in it returns 429; from another /64, 401. Reset requests 1–6 return 200 with sent true, and the account has exactly 1 usable reset link throughout.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ playwright }, testInfo) => {
    test.setTimeout(180_000);
    const baseURL = testInfo.project.use.baseURL;
    const clients: Awaited<ReturnType<typeof playwright.request.newContext>>[] = [];
    const client = async (address: string) => {
      const c = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": address } });
      clients.push(c);
      return c;
    };
    const newAccount = async () => {
      const token = uniqueToken(testInfo.workerIndex);
      const email = `pw-tester-lockout-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      // Generated for this test only and never logged or attached.
      const password = randomBytes(16).toString("base64url");
      const c = await client(uniqueTestAddress());
      expect((await c.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password } })).status()).toBe(201);
      return { email, password };
    };
    const signIn = (c: Awaited<ReturnType<typeof client>>, data: { email: string; password: string }) =>
      c.post("/api/v1/auth/login", { data });

    try {
      await test.step("Wrong passwords from one address lock it out there, not for the owner elsewhere", async () => {
        const target = await newAccount();
        const attacker = await client(uniqueTestAddress());
        const owner = await client(uniqueTestAddress());
        for (let i = 1; i <= FAILURES_PER_ACCOUNT_AND_ADDRESS; i++) {
          expect((await signIn(attacker, { email: target.email, password: "wrong-password" })).status(), `failure ${i}`).toBe(401);
        }
        const refused = await signIn(attacker, target);
        expect(refused.status()).toBe(429);
        expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
        expect((await signIn(owner, target)).status()).toBe(200);
      });

      await test.step("Guesses spread over many addresses still lock the account once there are 100", async () => {
        const target = await newAccount();
        const addresses = FAILURES_PER_ACCOUNT / FAILURES_PER_ACCOUNT_AND_ADDRESS;
        await Promise.all(
          Array.from({ length: addresses }, async (_, a) => {
            const c = await client(uniqueTestAddress());
            for (let i = 1; i <= FAILURES_PER_ACCOUNT_AND_ADDRESS; i++) {
              expect((await signIn(c, { email: target.email, password: "wrong-password" })).status(), `address ${a + 1}, failure ${i}`).toBe(401);
            }
          }),
        );
        expect((await signIn(await client(uniqueTestAddress()), target)).status()).toBe(429);
      });

      await test.step("IPv6: every address in one /64 shares that network's limit", async () => {
        const network = uniqueIpv6Network();
        for (let i = 1; i <= FAILURES_PER_ADDRESS; i++) {
          const c = await client(`${network}::${i.toString(16)}`);
          const email = `nobody-v6-${i}-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
          expect((await signIn(c, { email, password: "guess" })).status(), `failure ${i}`).toBe(401);
        }
        const probe = { email: `nobody-v6-probe-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`, password: "guess" };
        expect((await signIn(await client(`${network}:abcd:ef01:2345:6789`), probe)).status()).toBe(429);
        expect((await signIn(await client(`${uniqueIpv6Network()}::1`), probe)).status()).toBe(401);
      });

      await test.step("Reset requests while the last link still works send nothing new and cancel nothing", async () => {
        const target = await newAccount();
        const c = await client(uniqueTestAddress());
        for (let i = 1; i <= 6; i++) {
          const res = await c.post("/api/v1/auth/forgot-password", { data: { email: target.email } });
          expect(res.status(), `request ${i}`).toBe(200);
          expect(((await res.json()) as { sent: boolean }).sent, `request ${i}`).toBe(true);
          expect(await usableResetTokenCount(target.email), `request ${i}`).toBe(1);
        }
      });
    } finally {
      await Promise.all(clients.map((c) => c.dispose()));
    }
  },
);
