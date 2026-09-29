// TS-109: where to send the user after signing in, from a `?next=` query value. Only a same-origin
// path is ever honoured -- "/weddings/abc" yes; "https://evil.example", "//evil.example" and
// "/\evil.example" (which browsers treat as protocol-relative) no -- so a crafted login link can't
// bounce a freshly signed-in user to another site.
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}

// The login URL that brings the user back to `path` afterwards.
export function loginUrlReturningTo(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}
