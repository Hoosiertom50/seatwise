"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { ConfirmDeleteButton } from "@/components/ConfirmDeleteButton";
import { SUPPORT_EMAIL, SUPPORT_MAILTO, SUPPORT_PROMISE } from "@/lib/support";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

// TS-105: the signed-in planner's account page -- who they're signed in as, and deleting the
// account. Deleting needs the password, and is refused while they still own any wedding (Tom's
// decision, 2026-10-01): the page then lists those weddings with a link to hand each one off.
export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ name: string; email: string } | null>(null);
  const [password, setPassword] = useState("");
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

  // TS-204 (Tom's decision): "Log out" (on the dashboard) signs out this device only; this signs
  // out every device -- other browsers, phones, the mobile app -- the way a password reset does.
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);
  async function onLogOutEverywhere() {
    setSignOutError(null);
    setSigningOutEverywhere(true);
    try {
      await api.post("/api/v1/auth/logout", { everywhere: true });
    } catch {
      setSignOutError("Couldn't log out — check your connection and try again.");
      setSigningOutEverywhere(false);
      return;
    }
    router.replace("/login");
  }

  async function onDelete() {
    setError(null);
    setOwnedWeddings([]);
    try {
      await api.delete("/api/v1/auth/me", { password });
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
      <Link href="/dashboard" className="text-sm text-neutral-500 dark:text-neutral-400 underline">
        ← Back to your weddings
      </Link>
      <h1 className="mb-1 mt-4 text-2xl font-semibold">Your account</h1>
      {/* TS-199: a long name or address wraps instead of running off a phone screen. */}
      <p className="mb-8 break-words text-sm text-neutral-600 dark:text-neutral-300 [overflow-wrap:anywhere]">
        Signed in as {user.name} (<span className="break-all">{user.email}</span>)
      </p>

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
          type="button"
          onClick={onLogOutEverywhere}
          disabled={signingOutEverywhere}
          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          {signingOutEverywhere ? "Logging out…" : "Log out on all devices"}
        </button>
        {signOutError && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{signOutError}</p>}
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
                <Link href={`/weddings/${w.id}`} className="underline">
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
