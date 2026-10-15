"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { ConfirmDeleteButton } from "@/components/ConfirmDeleteButton";
import { AppearanceSetting } from "@/components/AppearanceSetting";
// TS-264: bell · Account · Log out, the same on every signed-in page.
import { SignedInHeader } from "@/components/SignedInHeader";
import { LOG_OUT, LOG_OUT_FAILED_MESSAGE, goToSignIn, logOutThisDevice } from "@/lib/log-out";
import { useUnsavedChangesProvider } from "@/lib/unsaved-changes";
import { SUPPORT_EMAIL, SUPPORT_MAILTO, SUPPORT_PROMISE } from "@/lib/support";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

// Review 14: "Log out on all devices" waiting on the leave question.
const LOG_OUT_EVERYWHERE = "log-out-everywhere";
const BACK = "__back__";

// TS-105: the signed-in planner's account page -- who they're signed in as, and deleting the
// account. Deleting needs the password, and is refused while they still own any wedding (Tom's
// decision, 2026-10-01): the page then lists those weddings with a link to hand each one off.
export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ name: string; email: string } | null>(null);
  const [password, setPassword] = useState("");
  // TS-264 (PR #114 review): leaving with a password typed in "Delete my account" -- Log out, the
  // bell, or Back to your weddings -- asks first rather than quietly throwing it away.
  const [pendingLeave, setPendingLeave] = useState<string | null>(null);
  const leaveOpener = useRef<HTMLElement | null>(null);
  // Review 15: the question opens where it can be seen -- asked from a control further down (a wedding
  // in the list, a link at the bottom) or after Back restored the scroll position, it used to open
  // above the screen with focus on its off-screen Stay (WebKit on a phone; Chromium after Back).
  const leaveQuestionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!(pendingLeave)) return;
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => leaveQuestionRef.current?.scrollIntoView({ block: "nearest" }))
    );
    return () => cancelAnimationFrame(frame);
  }, [pendingLeave]);
  function stay() {
    setPendingLeave(null);
    leaveOpener.current?.focus();
    leaveOpener.current = null;
  }
  const [logOutError, setLogOutError] = useState<string | null>(null);
  // Review 15 (Tom, 10-14): the browser's Back and a reload ask too, as on every other page -- the
  // same guard as the dashboard and the wedding page, held while a password is typed.
  const unsaved = useUnsavedChangesProvider({ onBackRequested: () => onBack() });
  const unsavedRegistry = unsaved.registry;
  useEffect(() => {
    unsavedRegistry.setDirty("delete-password", password !== "");
  }, [unsavedRegistry, password]);
  /** PR #114 review: Stay (or Escape) puts focus back on the control that asked. Review 15: asked
   * again while the question is already up (Back pressed then), the first control is kept. */
  function rememberOpener() {
    const active = document.activeElement;
    if (leaveOpener.current && active instanceof HTMLElement && active.closest('[role="alertdialog"]')) return;
    leaveOpener.current = active instanceof HTMLElement ? active : null;
  }
  function onLeave(href: string): boolean {
    if (password === "") {
      // PR #115 review: as on the dashboard -- just emptied, leave once its Back entry is off.
      if (!unsaved.guardSettling()) return true;
      void leaveOnceSettled(href);
      return false;
    }
    rememberOpener();
    setLogOutError(null);
    setPendingLeave(href);
    return false;
  }
  function onBack() {
    rememberOpener();
    setLogOutError(null);
    setPendingLeave(BACK);
  }
  async function leaveOnceSettled(href: string) {
    await unsaved.whenGuardSettled();
    await leaveFor(href);
  }
  async function leaveWithoutSaving() {
    const href = pendingLeave;
    setPendingLeave(null);
    if (href) await leaveFor(href);
    leaveOpener.current = null;
  }
  async function leaveFor(href: string) {
    // Review 14: the typed password stays until the page really goes -- a Log out that failed used
    // to clear it anyway, and focus fell to the top of the page instead of going back to Log out.
    if (href === BACK) {
      // Past the extra entry and this page; opened in a fresh tab there's nothing before it.
      unsaved.goBackPastPage(() => router.replace("/dashboard"));
    } else if (href === LOG_OUT) {
      if (await logOutThisDevice()) {
        unsaved.releaseForLink();
        goToSignIn();
      } else {
        setLogOutError(LOG_OUT_FAILED_MESSAGE);
        leaveOpener.current?.focus();
      }
    } else if (href === LOG_OUT_EVERYWHERE) {
      await onLogOutEverywhere();
    } else {
      setPassword("");
      if (unsaved.releaseForLink()) router.replace(href);
      else router.push(href);
    }
  }
  /** Review 14: the links in "Delete my account" ask first too (a click that opens a new tab doesn't). */
  function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.currentTarget.focus(); // Safari doesn't focus a clicked link; Stay brings focus back here.
    if (!onLeave(href)) e.preventDefault();
  }
  const [error, setError] = useState<string | null>(null);
  const [ownedWeddings, setOwnedWeddings] = useState<{ id: string; name: string }[]>([]);
  const [deleted, setDeleted] = useState(false);

  // TS-175: only "not signed in" goes to the sign-in page; any other failure says so, with Try
  // again (it used to send every error -- a dropped connection, say -- to sign-in).
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    api
      .get<{ user: { name: string; email: string } }>("/api/v1/auth/me")
      .then((res) => {
        setUser(res.user);
        setLoadFailed(false);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login?next=/account");
        else setLoadFailed(true);
      });
  }, [router, loadAttempt]);

  // TS-204 (Tom's decision): "Log out" (at the top of every page) signs out this device only; this signs
  // out every device -- other browsers, phones, the mobile app -- the way a password reset does.
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);
  const [signOutNeedsSignIn, setSignOutNeedsSignIn] = useState(false);
  async function onLogOutEverywhere() {
    setSignOutError(null);
    setSignOutNeedsSignIn(false);
    setSigningOutEverywhere(true);
    try {
      await api.post("/api/v1/auth/logout", { everywhere: true });
    } catch (err) {
      // TS-223: this tab's session had already ended, so nothing was signed out -- the server says
      // so (sign in again first), with a link to sign in. It used to go to the sign-in page as if
      // it had worked.
      const signedOut = err instanceof ApiError && err.status === 401;
      setSignOutNeedsSignIn(signedOut);
      setSignOutError(signedOut ? (err as ApiError).message : "Couldn't log out — check your connection and try again.");
      setSigningOutEverywhere(false);
      return;
    }
    unsaved.releaseForLink();
    goToSignIn();
  }
  // Review 15: a failed "Log out on all devices" puts focus back on the button (it was disabled
  // while waiting, which dropped focus to the top of the page).
  const logOutEverywhereButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (signOutError) logOutEverywhereButton.current?.focus();
  }, [signOutError]);

  async function onDelete() {
    setError(null);
    setOwnedWeddings([]);
    try {
      await api.delete("/api/v1/auth/me", { password });
      // PR #115 review: the password isn't unsaved input any more -- left counting, a reload of the
      // "deleted" page warned, and Back asked a question that page never shows (so Back did nothing).
      setPassword("");
      unsaved.clear();
      setDeleted(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && Array.isArray(err.data?.ownedWeddings)) {
        setOwnedWeddings(err.data.ownedWeddings as { id: string; name: string }[]);
      }
      setError(err instanceof ApiError ? err.message : "Couldn't delete your account.");
    }
  }

  if (deleted) {
    return (
      <main className="mx-auto max-w-xl px-4 py-12">
        <h1 className="mb-2 text-xl font-semibold">Your account has been deleted</h1>
        <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-300">
          Thanks for using Seatwise. Comments you wrote on other planners&apos; weddings stay, shown as
          written by &ldquo;Former member&rdquo;.
        </p>
        <Link href="/" className="text-sm underline">
          Back to the home page
        </Link>
      </main>
    );
  }

  if (!user && loadFailed) {
    return (
      <main className="mx-auto flex max-w-xl flex-wrap items-center gap-3 px-4 py-12 text-sm">
        <p role="alert" className="text-red-600 dark:text-red-400">
          Couldn&apos;t load your account.
        </p>
        <button
          type="button"
          onClick={() => setLoadAttempt((n) => n + 1)}
          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          Try again
        </button>
      </main>
    );
  }
  if (!user) return <main className="mx-auto max-w-xl px-4 py-12 text-sm text-neutral-500 dark:text-neutral-400">Loading…</main>;

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      {/* TS-264: the same bell · Account · Log out as every other signed-in page. */}
      <SignedInHeader
        onAccountPage
        onLeave={onLeave}
        logOutError={logOutError}
        left={
          <Link
            href="/dashboard"
            onClick={(e) => {
              e.currentTarget.focus(); // Safari doesn't focus a clicked link; Stay brings focus back here.
              if (!onLeave("/dashboard")) e.preventDefault();
            }}
            className="inline-flex min-h-11 items-center text-sm text-neutral-500 dark:text-neutral-400 underline"
          >
            ← Back to your weddings
          </Link>
        }
      />
      {pendingLeave && (
        <div
          ref={leaveQuestionRef}
          role="alertdialog"
          aria-labelledby="account-unsaved-question"
          // TS-212: Escape means Stay, as in every other question in the app.
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              stay();
            }
          }}
          className="mt-4 flex flex-wrap items-center gap-3 rounded-md bg-amber-50 dark:bg-amber-950 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
        >
          <span id="account-unsaved-question" className="flex-1">
            You&apos;ve typed your password to delete your account. Leave and clear it?
          </span>
          <button
            type="button"
            autoFocus
            onClick={stay}
            className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Stay
          </button>
          <button
            type="button"
            onClick={() => void leaveWithoutSaving()}
            className="min-h-11 rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
          >
            Leave without saving
          </button>
        </div>
      )}
      <h1 className="mb-1 mt-4 text-2xl font-semibold">Your account</h1>
      {/* TS-199: a long name or address wraps instead of running off a phone screen. */}
      <p className="mb-8 break-words text-sm text-neutral-600 dark:text-neutral-300 [overflow-wrap:anywhere]">
        Signed in as {user.name} (<span className="break-all">{user.email}</span>)
      </p>

      {/* TS-257 */}
      <AppearanceSetting />

      {/* TS-100 */}
      <section aria-labelledby="get-help" className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
        <h2 id="get-help" className="mb-1 text-lg font-medium">
          Get help
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Something not working, or a question?{" "}
          <a href={SUPPORT_MAILTO} className="font-medium underline">
            Email support
          </a>{" "}
          at {SUPPORT_EMAIL}. {SUPPORT_PROMISE}
        </p>
      </section>

      {/* TS-204 */}
      <section aria-labelledby="sign-out-everywhere" className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
        <h2 id="sign-out-everywhere" className="mb-1 text-lg font-medium">
          Signed in elsewhere
        </h2>
        <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-300">
          Log out signs out this device only. If you&apos;ve signed in on a shared or lost device, sign
          out everywhere — every browser, phone and app signed in to your account, this one included.
        </p>
        <button
          ref={logOutEverywhereButton}
          type="button"
          onClick={(e) => {
            // Review 14: with a password typed in "Delete my account", this asks first like Log out.
            e.currentTarget.focus();
            if (onLeave(LOG_OUT_EVERYWHERE)) void onLogOutEverywhere();
          }}
          disabled={signingOutEverywhere}
          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          {signingOutEverywhere ? "Logging out…" : "Log out on all devices"}
        </button>
        {/* TS-223: the live region is always on the page, so its message is announced (TS-212). */}
        <div role="alert" className="text-sm text-red-600 dark:text-red-400">
          {signOutError && (
            <p className="mt-3">
              {signOutError}
              {signOutNeedsSignIn && (
                <>
                  {" "}
                  {/* Review 16: asks first with a password typed, like every other way off this page. */}
                  <Link href="/login?next=/account" onClick={(e) => onLinkClick(e, "/login?next=/account")} className="underline">
                    Sign in
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="delete-account" className="rounded-lg border border-red-200 dark:border-red-900 p-4">
        <h2 id="delete-account" className="mb-1 text-lg font-medium">
          Delete my account
        </h2>
        <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-300">
          You&apos;ll lose access to every wedding you collaborate on, and your notifications and saved
          templates are deleted. Every wedding you own must first be handed off to someone (or deleted),
          so none is left without an owner.
        </p>
        <label htmlFor="delete-password" className="mb-1 block text-sm font-medium">
          Your password
        </label>
        <input
          maxLength={FIELD_LIMITS.password}
          id="delete-password"
          type="password"
          autoComplete="current-password"
          className="mb-3 w-full max-w-xs rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <ConfirmDeleteButton
            label="Delete my account"
            disabled={!password}
            question="Delete your Seatwise account? This can't be undone."
            confirmLabel="Yes, delete my account"
            busyLabel="Deleting…"
            className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
            onConfirm={onDelete}
          />
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {ownedWeddings.length > 0 && (
          <ul className="mt-2 list-inside list-disc text-sm">
            {ownedWeddings.map((w) => (
              <li key={w.id}>
                <Link href={`/weddings/${w.id}`} onClick={(e) => onLinkClick(e, `/weddings/${w.id}`)} className="underline">
                  {w.name}
                </Link>{" "}
                — open it, then Collaborators → Hand off this wedding (once someone else has access), or
                Delete this wedding
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
