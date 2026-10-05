"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";

// TS-164: shown to an account that hasn't confirmed its email address yet -- until it does,
// Seatwise won't send invites or RSVP emails for it, so it says so and offers a fresh link.
export function EmailVerificationNotice() {
  const [email, setEmail] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ user: { email: string; emailVerified: boolean } }>("/api/v1/auth/me")
      .then(({ user }) => setEmail(user.emailVerified ? null : user.email))
      .catch(() => setEmail(null));
  }, []);

  if (!email) return null;

  async function onResend() {
    setSending(true);
    setMessage(null);
    try {
      const res = await api.post<{ sent: boolean; alreadyVerified?: boolean }>("/api/v1/auth/verification-email");
      setMessage(res.alreadyVerified ? "Your email is already confirmed — reload the page." : `Sent — check ${email} (and your spam folder).`);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Couldn't send the email — please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      role="region"
      aria-label="Confirm your email"
      className="mb-6 flex flex-wrap items-center gap-3 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <span className="flex-1">
        Please confirm your email address — we sent a link to <span className="font-medium">{email}</span>. Until you
        do, Seatwise can&apos;t send invites or RSVP emails for you.
      </span>
      <button
        type="button"
        onClick={onResend}
        disabled={sending}
        className="rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
      >
        {sending ? "Sending…" : "Resend link"}
      </button>
      {message && (
        <p className="w-full text-sm" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
