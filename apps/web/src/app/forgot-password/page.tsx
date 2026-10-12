"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

// TS-142: ask for a password-reset link. Says plainly when there's no account for the email
// (Tom's decision, 2026-10-02), with a way to sign up instead.
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [noAccount, setNoAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNoAccount(null);
    setSending(true);
    try {
      const res = await api.post<{ sent: boolean; noAccount?: boolean; emailFailed?: boolean; message: string }>(
        "/api/v1/auth/forgot-password",
        { email }
      );
      if (res.sent) setMessage(res.message);
      else if (res.noAccount) setNoAccount(res.message);
      // TS-145: the email didn't go out -- say so, so they can try again.
      else setError(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong — please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-2xl font-semibold">Reset your password</h1>
        {message ? (
          <>
            <p role="status" className="mb-4 text-sm text-neutral-700 dark:text-neutral-300">
              {message}
            </p>
            <Link href="/login" className="text-sm font-medium underline">
              Back to sign in
            </Link>
          </>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              Enter the email you signed up with and we&apos;ll send you a link to choose a new password.
            </p>
            <div>
              <label htmlFor="forgot-email" className="mb-1 block text-sm font-medium">
                Email
              </label>
              <input
                maxLength={FIELD_LIMITS.email}
                id="forgot-email"
                type="email"
                autoComplete="email"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            {noAccount && (
              <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">
                {noAccount}{" "}
                <Link href="/signup" className="font-medium underline">
                  Sign up
                </Link>
              </p>
            )}
            {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={sending}
              className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
            >
              {sending ? "Sending..." : "Send reset link"}
            </button>
            <Link href="/login" className="text-sm underline">
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}
