// TS-73: the network address a request came from, for the per-address rate limits (TS-98 RSVP
// link, TS-113 sign-in). On Netlify, `x-forwarded-for` can't be trusted on its own -- a visitor can
// send their own value and have it passed along in front of the real one, which would let them
// dodge a per-address limit by making up a new address for every request. Netlify sets
// `x-nf-client-connection-ip` itself, from the actual connection, and documents it as the one to
// rely on, so it wins whenever it's present. Elsewhere (local dev, CI, the e2e suite) it isn't
// set, and the first `x-forwarded-for` entry is used as before.
//
// TS-171: an IPv6 connection is keyed by its /64 network rather than the full address. One home
// or server is normally handed a whole /64 -- billions of addresses -- so keying on the full
// address would give one source a fresh allowance for every address it picks.
export function clientAddress(req: { headers: Headers }): string {
  const first = (value: string | null) => value?.split(",")[0]?.trim() || null;
  const address =
    first(req.headers.get("x-nf-client-connection-ip")) ??
    first(req.headers.get("x-forwarded-for")) ??
    first(req.headers.get("x-real-ip")) ??
    "unknown";
  return rateLimitAddress(address);
}

/**
 * TS-171: what the per-address limits key on. IPv6 becomes its /64 network ("2001:db8:1:2::/64");
 * an IPv4 address written the IPv6 way ("::ffff:203.0.113.7") becomes the plain IPv4 address;
 * anything else (IPv4, or a value that isn't an IP address at all) is used as it is.
 */
export function rateLimitAddress(address: string): string {
  const groups = ipv6Groups(address);
  if (!groups) return address;
  // An IPv4 address written the IPv6 way (::ffff:a.b.c.d) is really that IPv4 address.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or null if `value` isn't one. */
function ipv6Groups(value: string): number[] | null {
  // "[2001:db8::1]" and "[2001:db8::1]:443" (with a port), and a "%eth0" zone, are all allowed.
  let text = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) text = bracketed[1];
  text = text.replace(/%[^%]*$/, "");
  if (!text.includes(":")) return null;

  // A dotted IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
  const ipv4Tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  let tail: number[] = [];
  if (ipv4Tail) {
    const octets = ipv4Tail.slice(2).map(Number);
    if (octets.some((o) => o > 255)) return null;
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    text = ipv4Tail[1].endsWith("::") ? ipv4Tail[1] : ipv4Tail[1].slice(0, -1);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const zeros = Array<number>(8 - known).fill(0);
  return [...head.map((g) => parseInt(g, 16)), ...zeros, ...rest.map((g) => parseInt(g, 16)), ...tail];
}
