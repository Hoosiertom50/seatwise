// TS-109: where to send the user after signing in, from a `?next=` query value. Only a same-origin
// path is ever honoured -- "/weddings/abc" yes; "https://evil.example", "//evil.example" and
// "/\evil.example" (which browsers treat as protocol-relative) no -- so a crafted login link can't
// bounce a freshly signed-in user to another site.
//
// TS-147: browsers silently drop tabs and line breaks from URLs, so "/<tab>/evil.example" used to
// pass the prefix checks and then resolve to "//evil.example". Now any control character or
// backslash anywhere is refused, and the path is resolved against a stand-in origin and only kept
// if it stays on that origin -- the same resolution the router itself does.
const PROBE_ORIGIN = "https://seatwise.invalid";

export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  // TS-162: dot segments ("/.//x", "/a/..//x", "/%2e%2e//x") pass the checks above and then
  // resolve to a path starting "//" -- which the router treats as another site. So the path that
  // comes out is checked too, not just what went in.
  const path = url.pathname + url.search + url.hash;
  if (path.startsWith("//") || path.includes("\\")) return fallback;
  return path;
}

// TS-122: the other auth page's URL, keeping this page's `?next=` along -- so switching between
// "Log in" and "Sign up" never drops where the user was headed (e.g. back to an invite).
export function withCurrentNext(authPath: "/login" | "/signup"): string {
  const next = new URLSearchParams(window.location.search).get("next");
  const safe = safeNextPath(next, "");
  return safe ? `${authPath}?next=${encodeURIComponent(safe)}` : authPath;
}

// The login URL that brings the user back to `path` afterwards.
export function loginUrlReturningTo(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}
