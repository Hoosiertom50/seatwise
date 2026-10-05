// Thin fetch wrapper, deliberately not reusing apps/web's src/lib/api-client.ts -- that one is
// cookie-only (the browser attaches the session cookie automatically), and per the README's own
// "Mobile later" note and the comment in apps/web/src/lib/auth.ts, a native client is expected to
// carry its own Bearer token instead. Same /api/v1 endpoints, same @seatwise/shared request/
// response shapes -- only how the token gets attached differs.

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

// Distinguished from ApiError so callers (in particular the offline queue) can tell "the server
// answered and rejected this" apart from "the request never reached the server at all" -- the
// latter is what FR-16.2 means by "unreliable venue connectivity" and is what triggers queueing,
// not a 4xx/5xx.
export class NetworkError extends Error {
  constructor(message = "Network request failed") {
    super(message);
    this.name = "NetworkError";
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
}

// TS-94: the server's sliding session renewal (apps/web/src/proxy.ts) hands a Bearer client its
// re-issued token in this response header -- there's no cookie jar here for it to land in.
export const RENEWED_TOKEN_HEADER = "x-seatwise-renewed-token";

export function createApiClient(
  baseUrl: string,
  getToken: () => Promise<string | null>,
  onRenewedToken?: (token: string) => Promise<void>
): ApiClient {
  async function request<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    const token = await getToken();
    // TS-172: tells the server this app keeps its own session token (sign-in sends it back only then).
    const headers: Record<string, string> = { "Content-Type": "application/json", "x-seatwise-client": "mobile" };
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      // fetch() throws for a genuine connectivity failure (no route to host, DNS, timeout) --
      // this is the "offline" case FR-16.2 is about, as opposed to any response the server did
      // manage to send back (including its own 5xx).
      throw new NetworkError();
    }

    // TS-94: keep the renewed token so an actively-used app never reaches its token's expiry --
    // which could otherwise land on the wedding day itself for a planner who signed in a month
    // earlier. Saved before the response is even inspected: the renewal is valid regardless of
    // whether this particular request succeeded.
    const renewed = res.headers.get(RENEWED_TOKEN_HEADER);
    if (renewed && onRenewedToken) await onRenewedToken(renewed);

    const contentType = res.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      throw new ApiError((body && body.error) || res.statusText, res.status, body);
    }
    return body as T;
  }

  return {
    get: <T>(path: string) => request<T>(path, { method: "GET" }),
    post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body }),
    patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body }),
  };
}
