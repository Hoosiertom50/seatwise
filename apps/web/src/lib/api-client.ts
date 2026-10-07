import { writeAwaitingConfirmation, writeFailed, writeStarted, writeSucceeded } from "./save-status";

export class ApiError extends Error {
  status: number;
  fieldErrors?: Record<string, string[] | undefined>;
  // FR-7.7: a 409 conflict response can carry a full refreshed payload (e.g. `planVersion`)
  // alongside the message -- the raw parsed body, for callers that need more than a string array.
  data?: Record<string, unknown>;
  constructor(
    message: string,
    status: number,
    fieldErrors?: Record<string, string[] | undefined>,
    data?: Record<string, unknown>
  ) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.data = data;
  }
}

// TS-109: fired on `window` when a request that needs a session gets a 401 after this page has
// already had one -- i.e. the session expired (or was cleared) mid-work. SessionExpiredNotice
// listens for it. Never fired for a page that was simply opened while signed out (nothing has
// succeeded yet, and that page's own load handling redirects to /login), nor for /api/v1/auth/*,
// where a 401 is an ordinary answer (e.g. a wrong password) rather than a lost session.
export const SESSION_EXPIRED_EVENT = "seatwise:session-expired";
// Fired once a request succeeds again after SESSION_EXPIRED_EVENT (e.g. after signing back in), so
// the notice can go away without anyone having to reason about which page it's on.
export const SESSION_RESTORED_EVENT = "seatwise:session-restored";
let hadSession = false;
let sessionExpired = false;
// TS-128: bumped each time the session is restored. A request that was already in flight before
// the planner signed back in (e.g. the wedding page's 4-second access poll, sent without a cookie)
// can come back 401 *after* the restore -- that answer is about the old, lost session, so it must
// not bring the notice straight back.
let sessionGeneration = 0;

// TS-93: a request that got no response at all (offline, DNS, connection dropped) -- status 0,
// since there is no HTTP status. Surfaced as an ApiError like any other failure, so every existing
// `err instanceof ApiError ? err.message : fallback` handler shows the user this instead of a
// generic fallback (fetch itself only ever throws an unhelpful "Failed to fetch" TypeError).
export const NETWORK_ERROR_STATUS = 0;
const NETWORK_ERROR_MESSAGE = "Couldn't reach Seatwise — check your connection and try again.";

// TS-93: how long to wait before each automatic retry of a request that got no response. Only
// GET/PATCH/DELETE are retried: re-reading is harmless, every PATCH that can conflict carries an
// expectedRevision (so a retry of one that did land comes back as a 409 with the fresh data, never
// a double apply), and a repeated DELETE only finds nothing left. POST is never retried -- if the
// first create landed and only its response was lost, a retry would create a duplicate.
const RETRY_DELAYS_MS = [400, 1200];

// TS-170: how long one request may take before it counts as having got no response. Without a
// limit, a request stuck on a dead connection never finished -- and changes queued behind it (see
// serial-tasks.ts) waited for good. Long enough for the slowest real request (a large import).
export const REQUEST_TIMEOUT_MS = 30_000;
// TS-182: generating a plan for a big wedding and committing a large import can honestly take
// longer than that -- they get two minutes, so a slow success isn't reported as "couldn't reach".
export const LONG_REQUEST_TIMEOUT_MS = 120_000;
const LONG_REQUESTS = [/\/plan-versions\/generate$/, /\/guests\/import\/commit$/];

/** TS-182: how long a request may take before it counts as having got no response. */
export function requestTimeoutFor(method: string, path: string): number {
  return method === "POST" && LONG_REQUESTS.some((re) => re.test(path)) ? LONG_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

// TS-175: responses that came from a retry (an earlier try got no answer, so it may have landed).
const retriedResponses = new WeakSet<Response>();
const ACCOUNT_PATH = "/api/v1/auth/me";

export async function fetchWithRetry(path: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const retryable = init.method !== "POST";
  for (let attempt = 0; ; attempt++) {
    try {
      // AbortSignal.timeout is in every browser Seatwise supports; without it, no limit (as before).
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
      const res = await fetch(path, signal ? { ...init, signal } : init);
      if (attempt > 0) retriedResponses.add(res);
      return res;
    } catch {
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
        throw new ApiError(NETWORK_ERROR_MESSAGE, NETWORK_ERROR_STATUS);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

// TS-177: the PATCH routes whose 409 hands back the fresh record under the same key their success
// answer uses -- so a retried save that turns out to have landed can be answered as a success.
const CONFLICT_RECORD_KEYS: { pattern: RegExp; key: string; extra?: Record<string, unknown>; textLike?: boolean }[] = [
  // TS-214: the wedding's own settings (name, date, venue, note, side names, RSVP cutoff) -- its
  // 409 sends the latest settings under `wedding`, as a save does. Text is compared the way the
  // server stores it (a blank box is saved as nothing, line breaks as "\n").
  { pattern: /^\/api\/v1\/weddings\/[^/]+$/, key: "wedding", textLike: true },
  { pattern: /^\/api\/v1\/weddings\/[^/]+\/guests\/[^/]+$/, key: "guest", extra: { warnings: [] } },
  { pattern: /^\/api\/v1\/weddings\/[^/]+\/tables\/[^/]+$/, key: "table", extra: { ok: true, warnings: [] } },
  { pattern: /^\/api\/v1\/weddings\/[^/]+\/vendors\/[^/]+$/, key: "vendor" },
  { pattern: /^\/api\/v1\/weddings\/[^/]+\/plan-versions\/[^/]+$/, key: "planVersion" },
  { pattern: /^\/api\/v1\/weddings\/[^/]+\/timeline-entries\/[^/]+$/, key: "entry" },
  { pattern: /^\/api\/v1\/weddings\/[^/]+\/budget$/, key: "summary" },
];

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// TS-214: a settings value as stored -- "" and null both mean "none", and "\r\n" is kept as "\n".
function storedText(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  const text = v.replace(/\r\n/g, "\n");
  return text === "" ? null : text;
}

/**
 * TS-177: a PATCH whose first try got no answer is retried (TS-93). If the first try did save, the
 * retry's expectedRevision is now stale, so it gets a 409 saying the edit wasn't saved -- untrue.
 * When the 409 carries the fresh record and every field that was sent already has the value sent,
 * the edit did land: this returns the success answer (the fresh record under the route's usual
 * key). Otherwise null -- a real conflict, or a route whose answer can't be rebuilt this way.
 */
export function resolveRetriedPatchConflict(
  path: string,
  sentBody: string | undefined,
  data: Record<string, unknown>
): Record<string, unknown> | null {
  const route = CONFLICT_RECORD_KEYS.find((r) => r.pattern.test(path));
  if (!route || !sentBody) return null;
  const fresh = data[route.key];
  if (!fresh || typeof fresh !== "object") return null;
  let sent: Record<string, unknown>;
  try {
    sent = JSON.parse(sentBody) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!sent || typeof sent !== "object") return null;
  const fields = Object.keys(sent).filter((k) => k !== "expectedRevision");
  if (fields.length === 0) return null;
  const record = fresh as Record<string, unknown>;
  const same = (k: string) =>
    route.textLike ? sameValue(storedText(sent[k]), storedText(record[k])) : sameValue(sent[k], record[k]);
  if (!fields.every((k) => k in record && same(k))) return null;
  return { ...route.extra, [route.key]: fresh };
}

/**
 * TS-199: true only when asking "who is signed in?" says there's no account any more.
 * TS-204: only when it says why -- ACCOUNT_GONE. A 401 for any other reason (this device was
 * logged out in another tab, a password reset ended the session) says nothing about whether the
 * account was deleted, and used to be taken as "deleted".
 */
async function accountCheck(): Promise<"ACCOUNT_GONE" | "SIGNED_OUT" | "UNKNOWN"> {
  try {
    const check = await fetchWithRetry(ACCOUNT_PATH, { method: "GET", credentials: "include" });
    if (check.status !== 401) return "UNKNOWN";
    const body = (await check.json().catch(() => ({}))) as { code?: unknown };
    return body.code === "ACCOUNT_GONE" ? "ACCOUNT_GONE" : "SIGNED_OUT";
  } catch {
    // No answer at all -- can't tell, so don't claim it was deleted.
    return "UNKNOWN";
  }
}

/** TS-204: a retried "Delete my account" whose answer was lost, and this device is signed out. */
export const ACCOUNT_DELETE_UNCONFIRMED =
  "You were signed out before we could confirm whether your account was deleted. Sign in to check — if your account still exists, you can delete it from there.";
// TS-209: the 404 answers that mean the wedding itself is gone or no longer open to this person
// ("Wedding not found" from the access check, "This wedding was deleted" from a save) -- as opposed
// to the one item a DELETE named (a guest, a vendor...) being gone already.
const WEDDING_GONE_404 = /^(Wedding not found|This wedding was deleted)/;

/** TS-209: whether a 404 answer is about the wedding rather than the item asked for. */
export function isWeddingGone404(data: { error?: unknown } | null | undefined): boolean {
  return typeof data?.error === "string" && WEDDING_GONE_404.test(data.error);
}

/** TS-209: a 404 about the item itself (deleted by someone else), not about the wedding. */
export function isItemGoneError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && !isWeddingGone404(err.data);
}

// TS-166: non-GET requests that don't save anything the planner made.
const NOT_A_SAVE = [/\/guests\/import\/preview$/, /^\/api\/v1\/notifications(\/[^/]+\/read)?$/];

/** TS-93 / TS-166: whether a request counts toward the "Saving… / Saved / Not saved" indicator. */
export function tracksSaveStatus(method: string, path: string): boolean {
  if (method === "GET" || path.startsWith("/api/v1/auth/")) return false;
  return !NOT_A_SAVE.some((re) => re.test(path));
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isAuthRoute = path.startsWith("/api/v1/auth/");
  // TS-93: every write except signing in/out counts toward the visible save status.
  // TS-166: so do requests that only look something up or mark notifications read -- a failed
  // import preview used to show "Not saved" in the header when nothing was being saved.
  const tracksSave = tracksSaveStatus(options.method ?? "GET", path);
  if (tracksSave) writeStarted();
  const startedInGeneration = sessionGeneration;

  let res: Response;
  try {
    res = await fetchWithRetry(path, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }, requestTimeoutFor(options.method ?? "GET", path));
  } catch (err) {
    if (tracksSave) writeFailed(NETWORK_ERROR_MESSAGE);
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  // TS-175: a retried delete that finds nothing means the first try did delete it (only its answer
  // was lost) -- that's success. It used to count as a failure, and the item came back on screen.
  // TS-186: the same for deleting one's own account -- a retry after the first try deleted it finds
  // no signed-in account (401), which means it worked.
  // TS-199: but a 401 on that retry could also be a session that ran out while the first try never
  // arrived. Before saying the account is gone, ask who is signed in: still signed in (200) means
  // it wasn't deleted; no account (401) means it was.
  const retriedAccount401 =
    options.method === "DELETE" && retriedResponses.has(res) && res.status === 401 && path === ACCOUNT_PATH;
  // TS-204: only "this account no longer exists" counts as deleted (see accountCheck).
  const accountState = retriedAccount401 ? await accountCheck() : null;
  const accountReallyGone = accountState === "ACCOUNT_GONE";
  // TS-209: and a first try that finds the item already gone -- someone else deleted it a moment
  // earlier. It used to come back on screen with "Couldn't delete". Not when it's the wedding that's
  // gone (or no longer theirs): that 404 is a real answer the page must show.
  const firstTryItemGone =
    options.method === "DELETE" && res.status === 404 && path !== ACCOUNT_PATH && !isWeddingGone404(data);
  const alreadyGone =
    (options.method === "DELETE" && retriedResponses.has(res) && (res.status === 404 || accountReallyGone)) ||
    firstTryItemGone;
  // TS-177: likewise a retried edit "refused" only because the first try already saved it.
  const alreadySaved =
    options.method === "PATCH" && res.status === 409 && retriedResponses.has(res)
      ? resolveRetriedPatchConflict(path, typeof options.body === "string" ? options.body : undefined, data)
      : null;
  const ok = res.ok || alreadyGone || alreadySaved !== null;

  if (tracksSave) {
    if (ok) writeSucceeded();
    else if (data.needsConfirmation === true) writeAwaitingConfirmation();
    else if (res.status === 401) writeFailed("Not saved — your session has expired.");
    else writeFailed(data.error || "Something went wrong");
  }

  if (typeof window !== "undefined") {
    if (res.ok && sessionExpired) {
      sessionExpired = false;
      sessionGeneration++;
      window.dispatchEvent(new Event(SESSION_RESTORED_EVENT));
    }
    if (res.ok && !isAuthRoute) hadSession = true;
    if (res.status === 401 && !isAuthRoute && hadSession && startedInGeneration === sessionGeneration) {
      sessionExpired = true;
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
  }

  if (alreadyGone) return {} as T;
  if (alreadySaved) return alreadySaved as T;
  // TS-204: the retry was refused because this device is signed out (logged out in another tab, a
  // password reset) while the account still exists -- say so, instead of a false "deleted".
  if (accountState === "SIGNED_OUT") throw new ApiError(ACCOUNT_DELETE_UNCONFIRMED, 401, undefined, data);
  if (!res.ok) {
    throw new ApiError(data.error || "Something went wrong", res.status, data.fieldErrors, data);
  }
  return data as T;
}

// A 422's top-level message is always the generic "Validation failed" -- the actually useful text
// (e.g. "Can only contain letters, spaces, hyphens, apostrophes, and periods") lives in
// fieldErrors, keyed by field name. This picks the first message for any of the given fields,
// falling back to the error's own message (or a caller-supplied default for a non-ApiError) when
// there's nothing more specific -- so a caller can show the user why a save was rejected instead
// of just "Validation failed".
export function apiErrorMessage(err: unknown, fields: string[], fallback: string): string {
  if (err instanceof ApiError) {
    for (const field of fields) {
      const msg = err.fieldErrors?.[field]?.[0];
      if (msg) return msg;
    }
    // TS-151: a 422's own message is only "Validation failed" -- any field's reason says more.
    const anyField = Object.values(err.fieldErrors ?? {}).find((m) => m?.[0])?.[0];
    if (anyField) return anyField;
    return err.message;
  }
  return fallback;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  // TS-105: an optional body, e.g. the password confirming an account deletion.
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "DELETE", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
};
