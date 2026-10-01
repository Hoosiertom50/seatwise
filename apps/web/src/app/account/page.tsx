"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { ConfirmDeleteButton } from "@/components/ConfirmDeleteButton";

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

  useEffect(() => {
    api
      .get<{ user: { name: string; email: string } }>("/api/v1/auth/me")
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login?next=/account"));
  }, [router]);

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

  if (!user) return <main className="mx-auto max-w-xl px-4 py-12 text-sm text-neutral-500">Loading…</main>;

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <Link href="/dashboard" className="text-sm text-neutral-500 dark:text-neutral-400 underline">
        ← Back to your weddings
      </Link>
      <h1 className="mb-1 mt-4 text-2xl font-semibold">Your account</h1>
      <p className="mb-8 text-sm text-neutral-600 dark:text-neutral-300">
        Signed in as {user.name} ({user.email})
      </p>

      <section aria-labelledby="delete-account" className="rounded-lg border border-red-200 dark:border-red-900 p-4">
        <h2 id="delete-account" className="mb-1 text-lg font-medium">
          Delete my account
        </h2>
        <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-300">
          You&apos;ll lose access to every wedding you collaborate on, and your notifications and saved
          templates are deleted. Every wedding you own must be handed off to someone first, so none is
          left without an owner.
        </p>
        <label htmlFor="delete-password" className="mb-1 block text-sm font-medium">
          Your password
        </label>
        <input
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
        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {ownedWeddings.length > 0 && (
          <ul className="mt-2 list-inside list-disc text-sm">
            {ownedWeddings.map((w) => (
              <li key={w.id}>
                <Link href={`/weddings/${w.id}`} className="underline">
                  {w.name}
                </Link>{" "}
                — open it, then Collaborators → Hand off this wedding
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
