// TS-73: the network address a request came from, for the per-address rate limits (TS-98 RSVP
// link, TS-113 sign-in). On Netlify, `x-forwarded-for` can't be trusted on its own -- a visitor can
// send their own value and have it passed along in front of the real one, which would let them
// dodge a per-address limit by making up a new address for every request. Netlify sets
// `x-nf-client-connection-ip` itself, from the actual connection, and documents it as the one to
// rely on, so it wins whenever it's present. Elsewhere (local dev, CI, the e2e suite) it isn't
// set, and the first `x-forwarded-for` entry is used as before.
export function clientAddress(req: { headers: Headers }): string {
  const first = (value: string | null) => value?.split(",")[0]?.trim() || null;
  return (
    first(req.headers.get("x-nf-client-connection-ip")) ??
    first(req.headers.get("x-forwarded-for")) ??
    first(req.headers.get("x-real-ip")) ??
    "unknown"
  );
}
