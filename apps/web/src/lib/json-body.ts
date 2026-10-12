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

// TS-200: the largest request body accepted, in bytes. The biggest thing anyone sends is a guest
// list file for import: the browser reads the file and sends its text as one JSON string, and the
// server takes up to 2,000,000 characters of it (guestImportRequestSchema). JSON writes each quote
// and line break in the file as two characters, and accented letters take two or three bytes, so a
// file just inside the 2 MB limit can come to more than 2 MB on the wire -- 4.5 MB covers even a
// file made of nothing but quotes and line breaks (4 MB), and is still under Netlify's own 6 MB
// limit for a request. Anything bigger is refused (413) before it's read, instead of being read and
// parsed only to be refused afterwards.
export const MAX_JSON_BODY_BYTES = 4_500_000;

export const BODY_TOO_LARGE_MESSAGE = "That's too much to send at once — keep an imported file under 2 MB.";

/** TS-200: whether the request says (Content-Length) its body is bigger than `maxBytes`. Headers only. */
export function declaresBodyTooLarge(headers: Headers, maxBytes = MAX_JSON_BODY_BYTES): boolean {
  const length = Number(headers.get("content-length") ?? "0");
  return Number.isFinite(length) && length > maxBytes;
}

/**
 * TS-200: reads a request body as text, giving up (null) as soon as it passes `maxBytes` -- for a
 * body sent without a Content-Length (in pieces), whose size isn't known until it's been read.
 */
export async function readBodyTextWithin(
  body: ReadableStream<Uint8Array> | null,
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
