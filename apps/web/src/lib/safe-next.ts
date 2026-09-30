// TS-109: where to send the user after signing in, from a `?next=` query value. Only a same-origin
// path is ever honoured -- "/weddings/abc" yes; "https://evil.example", "//evil.example" and
// "/\evil.example" (which browsers treat as protocol-relative) no -- so a crafted login link can't
// bounce a freshly signed-in user to another site.
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
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
