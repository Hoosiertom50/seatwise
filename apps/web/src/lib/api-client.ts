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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(data.error || "Something went wrong", res.status, data.fieldErrors, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
