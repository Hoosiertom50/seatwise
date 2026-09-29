"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SESSION_EXPIRED_EVENT, SESSION_RESTORED_EVENT } from "@/lib/api-client";
import { loginUrlReturningTo } from "@/lib/safe-next";

// TS-109: an expired session used to surface as "Your access to this wedding has been removed"
// (the wedding page treated a 401 like a 404) and tore the page down. This says what actually
// happened, leaves the page and everything on it mounted, and offers a sign-in that comes back here.
export function SessionExpiredNotice() {
  const pathname = usePathname();
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const onExpired = () => setExpired(true);
    const onRestored = () => setExpired(false);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    window.addEventListener(SESSION_RESTORED_EVENT, onRestored);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      window.removeEventListener(SESSION_RESTORED_EVENT, onRestored);
    };
  }, []);

  // Signing in (or up) is exactly what this notice asks for -- never shown on those pages.
  if (!expired || pathname === "/login" || pathname === "/signup") return null;

  const here = `${pathname}${typeof window !== "undefined" ? window.location.search : ""}`;
  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-4 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
      <span>Your session has expired, so changes can&apos;t be saved right now. Sign in again to keep working.</span>
      <Link href={loginUrlReturningTo(here)} className="font-medium underline hover:no-underline">
        Sign in again
      </Link>
    </div>
  );
}
