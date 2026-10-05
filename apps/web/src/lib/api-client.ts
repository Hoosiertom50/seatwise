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

// TS-175: responses that came from a retry (an earlier try got no answer, so it may have landed).
const retriedResponses = new WeakSet<Response>();

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
    });
  } catch (err) {
    if (tracksSave) writeFailed(NETWORK_ERROR_MESSAGE);
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  // TS-175: a retried delete that finds nothing means the first try did delete it (only its answer
  // was lost) -- that's success. It used to count as a failure, and the item came back on screen.
  const alreadyGone = options.method === "DELETE" && res.status === 404 && retriedResponses.has(res);
  const ok = res.ok || alreadyGone;

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
