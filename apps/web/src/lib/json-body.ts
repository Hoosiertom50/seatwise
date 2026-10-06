// TS-179: the one rule for "this request's body isn't JSON", shared by proxy.ts (every API write)
// and readJson() in api-response.ts (each route that reads a body checks again, so a route never
// relies on the proxy alone). A body must be sent as application/json; a request with no body at
// all needs no type. Pure (headers only), so it's safe to use anywhere.
export function isNonJsonBody(headers: Headers): boolean {
  const type = headers.get("content-type");
  if (type) return !type.toLowerCase().trimStart().startsWith("application/json");
  const hasBody = Number(headers.get("content-length") ?? "0") > 0 || headers.has("transfer-encoding");
  return hasBody;
}
