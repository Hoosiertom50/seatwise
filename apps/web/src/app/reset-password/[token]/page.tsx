"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

// TS-142: opened from the emailed reset link. Checks the link still works, then lets the planner
// choose a new password; saving it uses up the link and signs them in.
export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [usable, setUsable] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ usable: boolean }>(`/api/v1/auth/reset-password/${token}`)
      .then((res) => setUsable(res.usable))
      // A rate limit (or outage) isn't the same as a dead link -- say what actually happened.
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Couldn't check your link — please try again."));
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/api/v1/auth/reset-password/${token}`, { password });
      router.push("/dashboard");
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && /no longer valid/.test(err.message)) setUsable(false);
      setError(err instanceof ApiError ? (err.fieldErrors?.password?.[0] ?? err.message) : "Couldn't save your new password.");
      setSaving(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-4 text-2xl font-semibold">Choose a new password</h1>
        {loadError ? (
          <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        ) : usable === null ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Checking your link…</p>
        ) : !usable ? (
          <>
            <p className="mb-4 text-sm text-neutral-700 dark:text-neutral-300">
              This reset link is no longer valid — request a new one.
            </p>
            <Link href="/forgot-password" className="text-sm font-medium underline">
              Send a new link
            </Link>
          </>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <label htmlFor="reset-password" className="mb-1 block text-sm font-medium">
                New password
              </label>
              <input
                maxLength={FIELD_LIMITS.password}
                id="reset-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">At least 8 characters.</p>
            </div>
            <div>
              <label htmlFor="reset-password-confirm" className="mb-1 block text-sm font-medium">
                Type it again
              </label>
              <input
                maxLength={FIELD_LIMITS.password}
                id="reset-password-confirm"
                type="password"
                autoComplete="new-password"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save new password"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
