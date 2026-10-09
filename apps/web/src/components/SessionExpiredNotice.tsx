"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api, ApiError, SESSION_EXPIRED_EVENT, SESSION_RESTORED_EVENT } from "@/lib/api-client";
import { loginUrlReturningTo } from "@/lib/safe-next";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";
import { announceSignedIn, watchForSignIn } from "@/lib/session-sync";

// TS-109: an expired session used to surface as "Your access to this wedding has been removed"
// (the wedding page treated a 401 like a 404) and tore the page down. This says what actually
// happened and leaves the page and everything on it mounted.
//
// TS-94: and lets the planner sign back in right here, without leaving the page -- so whatever they
// had open (a half-typed guest, an unsaved form, their place in a long list) is still there
// afterwards. The full sign-in page stays available as a fallback link.
export function SessionExpiredNotice() {
  const pathname = usePathname();
  const [expired, setExpired] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onExpired = () => setExpired(true);
    const onRestored = () => {
      setExpired(false);
      setPassword("");
      setError(null);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    window.addEventListener(SESSION_RESTORED_EVENT, onRestored);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      window.removeEventListener(SESSION_RESTORED_EVENT, onRestored);
    };
  }, []);

  // TS-229: while the notice shows, re-check the session the moment another page signs in, or this
  // page is shown again or regains focus -- rather than waiting for a poll (some pages have none).
  // A successful check fires SESSION_RESTORED_EVENT (api-client), which hides the notice.
  useEffect(() => {
    if (!expired) return;
    return watchForSignIn(() => api.get("/api/v1/auth/me"));
  }, [expired]);

  // Signing in (or up) is exactly what this notice asks for -- never shown on those pages.
  if (!expired || pathname === "/login" || pathname === "/signup") return null;

  async function onSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSigningIn(true);
    setError(null);
    try {
      // A successful sign-in fires SESSION_RESTORED_EVENT (api-client), which hides this notice.
      await api.post("/api/v1/auth/login", { email, password });
      // TS-229: and other open pages showing this notice pick the new session up at once.
      announceSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't sign in.");
    } finally {
      setSigningIn(false);
    }
  }

  const here = `${pathname}${typeof window !== "undefined" ? window.location.search : ""}`;
  const input =
    "rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100";
  return (
    <div
      role="alert"
      className="sticky top-0 z-50 border-b border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-4 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
      <p className="text-center">
        Your session has expired, so changes can&apos;t be saved right now. Sign in again to keep working
        — everything on this page stays as it is.
      </p>
      <form onSubmit={onSignIn} className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <label className="sr-only" htmlFor="reauth-email">
          Email
        </label>
        <input
          maxLength={FIELD_LIMITS.email}
          id="reauth-email"
          type="email"
          autoComplete="email"
          placeholder="Email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={input}
        />
        <label className="sr-only" htmlFor="reauth-password">
          Password
        </label>
        <input
          maxLength={FIELD_LIMITS.password}
          id="reauth-password"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={input}
        />
        <button
          type="submit"
          disabled={signingIn}
          className="rounded-md bg-amber-800 dark:bg-amber-300 px-3 py-1 font-medium text-white dark:text-amber-950 hover:bg-amber-900 dark:hover:bg-amber-200 disabled:opacity-50"
        >
          {signingIn ? "Signing in…" : "Sign in here"}
        </button>
        {/* TS-170: in a new tab -- this page keeps whatever was being typed when the session ran
            out, and it picks up the new session once you've signed in there. */}
        <Link href={loginUrlReturningTo(here)} target="_blank" rel="noopener" className="underline hover:no-underline">
          or use the sign-in page (opens a new tab)
        </Link>
      </form>
      {error && <p className="mt-1 text-center text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
