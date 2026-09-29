/**
 * TS-93 / TS-110 — deterministic save-failure injection for the "a save can fail" test cases.
 * Intercepts matching browser requests on one page and answers them itself, so a test can prove
 * what the UI does when the server (or the network) refuses a write, without needing a real
 * outage. Only ever affects the page it's installed on; `context.request` API calls a test makes
 * for its own setup/assertions go straight to the real server.
 */

import type { Page, Route } from "@playwright/test";

export interface FaultHandle {
  /** How many requests this fault has intercepted so far. */
  readonly hits: number;
  /** Stops intercepting -- later matching requests reach the real server again. */
  clear(): Promise<void>;
}

type Fault = { status: number; error: string } | "network";

/** Fails every `method` request to a URL matching `urlPattern` with `fault` -- either an HTTP
 * error status carrying the app's standard `{ error }` body, or `"network"` to abort the request
 * the way a dropped connection would. */
export async function failRequests(
  page: Page,
  urlPattern: string | RegExp,
  method: string,
  fault: Fault,
): Promise<FaultHandle> {
  let hits = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    hits++;
    if (fault === "network") return route.abort("connectionfailed");
    return route.fulfill({
      status: fault.status,
      contentType: "application/json",
      body: JSON.stringify({ error: fault.error }),
    });
  };
  await page.route(urlPattern, handler);
  return {
    get hits() {
      return hits;
    },
    clear: () => page.unroute(urlPattern, handler),
  };
}
