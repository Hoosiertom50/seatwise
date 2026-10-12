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
 * the way a dropped connection would. With `times`, only the first `times` matching requests fail
 * and later ones reach the real server (e.g. a connection blip that a retry recovers from). */
export async function failRequests(
  page: Page,
  urlPattern: string | RegExp,
  method: string,
  fault: Fault,
  times = Infinity,
): Promise<FaultHandle> {
  let hits = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== method || hits >= times) return route.fallback();
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

/** Holds every `method` request to a URL matching `urlPattern` for `ms` before letting it through
 * to the real server -- makes an in-flight state (e.g. "Saving…") observable instead of racing a
 * sub-100ms local request. */
export async function delayRequests(
  page: Page,
  urlPattern: string | RegExp,
  method: string,
  ms: number,
): Promise<FaultHandle> {
  let hits = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    hits++;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return route.fallback();
  };
  await page.route(urlPattern, handler);
  return {
    get hits() {
      return hits;
    },
    clear: () => page.unroute(urlPattern, handler),
  };
}

/** TS-199: starts watching for a `method` request to a URL matching `urlPattern`; the returned
 * promise says whether one was sent within `ms` -- for checking that something (an arrow key, say)
 * did NOT save. Start it before the action, await it after. */
export function watchForRequest(page: Page, urlPattern: RegExp, method: string, ms: number): Promise<boolean> {
  return page
    .waitForRequest((req) => req.method() === method && urlPattern.test(req.url()), { timeout: ms })
    .then(() => true)
    .catch(() => false);
}

/** TS-182: lets every `method` request to a URL matching `urlPattern` reach the real server at
 * once, then holds its answer for `ms` before the page gets it -- so a test can make a save that
 * was done first come back last (its answer then carries what the server held at that moment). */
export async function delayResponses(
  page: Page,
  urlPattern: string | RegExp,
  method: string,
  ms: number,
): Promise<FaultHandle & { readonly answered: number }> {
  let hits = 0;
  let answered = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    hits++;
    const response = await route.fetch();
    // The server has answered (and so has made the change); the page hasn't heard yet.
    answered++;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return route.fulfill({ response });
  };
  await page.route(urlPattern, handler);
  return {
    get hits() {
      return hits;
    },
    get answered() {
      return answered;
    },
    clear: () => page.unroute(urlPattern, handler),
  };
}

/** TS-209: lets the first `times` `method` requests to a URL matching `urlPattern` reach the real
 * server (so whatever they change is saved), then drops their answers the way a lost connection
 * would -- the page sees no response at all. For proving a retry of a request that did land. */
export async function loseResponses(
  page: Page,
  urlPattern: string | RegExp,
  method: string,
  times = 1,
): Promise<FaultHandle> {
  let hits = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== method || hits >= times) return route.fallback();
    hits++;
    await route.fetch();
    return route.abort("connectionfailed");
  };
  await page.route(urlPattern, handler);
  return {
    get hits() {
      return hits;
    },
    clear: () => page.unroute(urlPattern, handler),
  };
}

/** TS-197: sends every `method` request to a URL matching `urlPattern` on to the real server with
 * its JSON body changed by `change` -- for a request the page can't be made to send as it stands
 * (e.g. a Generate asking for a comparison draft before any plan exists). */
export async function rewriteRequestJson(
  page: Page,
  urlPattern: string | RegExp,
  method: string,
  change: (body: Record<string, unknown>) => Record<string, unknown>,
): Promise<FaultHandle> {
  let hits = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    hits++;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    return route.fallback({ postData: JSON.stringify(change(body)) });
  };
  await page.route(urlPattern, handler);
  return {
    get hits() {
      return hits;
    },
    clear: () => page.unroute(urlPattern, handler),
  };
}

/** TS-206: holds every `method` request to a URL matching `urlPattern` for `ms`, then refuses it
 * with `status` and the app's standard `{ error }` body -- for a save that fails only after the
 * page has moved on (e.g. its tab was closed meanwhile). */
export async function delayThenFailRequests(
  page: Page,
  urlPattern: string | RegExp,
  method: string,
  ms: number,
  fault: { status: number; error: string },
): Promise<FaultHandle> {
  let hits = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    hits++;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return route.fulfill({ status: fault.status, contentType: "application/json", body: JSON.stringify({ error: fault.error }) });
  };
  await page.route(urlPattern, handler);
  return {
    get hits() {
      return hits;
    },
    clear: () => page.unroute(urlPattern, handler),
  };
}

/** TS-209: lets the first `times` `method` requests to a URL matching `urlPattern` reach the real
 * server (so the change is saved), then hands the page the answer with `key` set to null -- the
 * way the server answers when the change saved but the record couldn't be read back afterwards. */
export async function dropReadBack(
  page: Page,
  urlPattern: string | RegExp,
  method: string,
  key: string,
  times = 1,
): Promise<FaultHandle> {
  let hits = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== method || hits >= times) return route.fallback();
    hits++;
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    const warnings = Array.isArray(body.warnings) ? body.warnings : [];
    return route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({
        ...body,
        [key]: null,
        warnings: [...warnings, "Saved, but Seatwise couldn't load the latest just now — refresh the page to see it."],
      }),
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

/** TS-208/TS-209: runs `before` (e.g. deleting the record through the API, as another planner
 * would) just before the first `times` `method` requests to a URL matching `urlPattern` go on to
 * the real server -- so the page's request finds the change already made, with no timing race. */
export async function beforeRequests(
  page: Page,
  urlPattern: string | RegExp,
  method: string,
  before: () => Promise<void>,
  times = 1,
): Promise<FaultHandle> {
  let hits = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== method || hits >= times) return route.fallback();
    hits++;
    await before();
    return route.fallback();
  };
  await page.route(urlPattern, handler);
  return {
    get hits() {
      return hits;
    },
    clear: () => page.unroute(urlPattern, handler),
  };
}
