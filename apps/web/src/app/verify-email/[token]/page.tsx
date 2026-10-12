"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";

// TS-164: opened from the "confirm your email" link. Confirming takes a click rather than happening
// as the page opens, so a mail scanner that opens links on the person's behalf can't confirm it.
export default function VerifyEmailPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<"ready" | "working" | "done">("ready");
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setError(null);
    setState("working");
    try {
      await api.post("/api/v1/auth/verify-email", { token });
      setState("done");
    } catch (err) {
      setError(err instanceof ApiError ? (err.fieldErrors?.token?.[0] ?? err.message) : "Couldn't confirm your email — please try again.");
      setState("ready");
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="mb-4 text-2xl font-semibold">Confirm your email</h1>
        {state === "done" ? (
          <>
            <p className="mb-4 text-sm text-neutral-700 dark:text-neutral-300" role="status">
              Thanks — your email address is confirmed.
            </p>
            <Link href="/dashboard" className="text-sm font-medium underline">
              Go to your dashboard
            </Link>
          </>
        ) : (
          <>
            <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-300">
              Confirm this is your email address, so Seatwise can send invites and RSVP emails for you.
            </p>
            <button
              type="button"
              onClick={onConfirm}
              disabled={state === "working"}
              className="min-h-11 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {state === "working" ? "Confirming…" : "Confirm my email"}
            </button>
            {/* TS-179 (Tom's decision): someone else may have signed up with this address. */}
            <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300" data-testid="verify-email-not-yours">
              If you didn&apos;t create this Seatwise account, don&apos;t confirm — use{" "}
              <Link href="/forgot-password" className="font-medium underline">
                Forgot password
              </Link>{" "}
              on the{" "}
              <Link href="/login" className="font-medium underline">
                sign-in page
              </Link>{" "}
              to take it over instead.
            </p>
            {error && (
              <p className="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
