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

export function createApiClient(baseUrl: string, getToken: () => Promise<string | null>): ApiClient {
  async function request<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    const token = await getToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
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
