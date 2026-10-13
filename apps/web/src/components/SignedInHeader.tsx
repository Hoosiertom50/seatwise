"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NotificationsBell } from "@/components/NotificationsBell";
import { LOG_OUT, LOG_OUT_FAILED_MESSAGE, logOutThisDevice } from "@/lib/log-out";

const CONTROL =
  "flex min-h-11 items-center rounded-md border border-neutral-300 dark:border-neutral-600 px-3 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800";

/**
 * TS-264 (Tom's decision, 10-13): the same controls at the top right of every signed-in page --
 * the dashboard, every wedding tab and the Account page: 🔔 bell · Account · Log out. Log out used
 * to be on the dashboard only, so leaving a borrowed tablet signed in on Day-of mode took two
 * clicks. On a phone the controls stay in the top-right corner (44px targets) and whatever is on
 * the left wraps instead; Tab goes left, then right, then down (TS-193).
 */
export function SignedInHeader({
  left,
  status,
  onLeave,
  logOutError,
  onAccountPage = false,
}: {
  /** The page's own top-left content (a heading, or a back link). */
  left: ReactNode;
  /** Shown under the controls, on the right (the wedding page's save status). */
  status?: ReactNode;
  /**
   * Asked before following the Account link, the bell's "Back to dashboard" and Log out (with
   * LOG_OUT as the address). Returning false stops it -- the wedding page then asks about unsaved
   * changes, or waits for saves, and carries on itself (TS-159/TS-170/TS-206).
   */
  onLeave?: (href: string) => boolean;
  /** Why a log out the page carried on with itself (after its question) didn't work. */
  logOutError?: string | null;
  /** On the Account page the Account link is the current page. */
  onAccountPage?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const loggingOut = useRef(false);
  const logOutButton = useRef<HTMLButtonElement>(null);
  const accountLink = useRef<HTMLAnchorElement>(null);

  // TS-204: this device only, then the sign-in page -- exactly what the dashboard's Log out did.
  async function onLogOut() {
    setError(null);
    // Focus on Log out first (Safari doesn't focus a clicked button), so Stay on the unsaved-changes
    // question brings it back here rather than to the top of the page (TS-191).
    logOutButton.current?.focus();
    if (onLeave && !onLeave(LOG_OUT)) return;
    if (loggingOut.current) return;
    loggingOut.current = true;
    try {
      if (await logOutThisDevice()) router.replace("/login");
      else setError(LOG_OUT_FAILED_MESSAGE);
    } finally {
      loggingOut.current = false;
    }
  }

  const shownError = error ?? logOutError ?? null;
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-3">
      <div className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{left}</div>
      <nav aria-label="Your account" className="flex shrink-0 items-center gap-2">
        <NotificationsBell onLeave={onLeave} />
        {/* TS-105 */}
        <Link
          href="/account"
          aria-current={onAccountPage ? "page" : undefined}
          ref={accountLink}
          onClick={(e) => {
            if (!onLeave) return;
            accountLink.current?.focus(); // As for Log out below.
            if (!onLeave("/account")) e.preventDefault();
          }}
          className={CONTROL}
        >
          Account
        </Link>
        <button ref={logOutButton} type="button" onClick={() => void onLogOut()} className={CONTROL}>
          Log out
        </button>
      </nav>
      {status !== undefined && <div className="mt-1 flex w-full justify-end text-right">{status}</div>}
      {/* TS-212: always on the page (empty, it takes no room), so a failed log out is announced. A
          div, not a p: the tabs' own error lines are the page's red paragraphs. */}
      <div role="alert" className={`w-full text-right text-sm text-red-600 dark:text-red-400 ${shownError ? "mt-1" : ""}`}>
        {shownError ?? ""}
      </div>
    </header>
  );
}
