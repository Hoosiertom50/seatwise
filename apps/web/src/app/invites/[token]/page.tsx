"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import type { InvitePreviewDTO } from "@seatwise/shared";
import { loginUrlReturningTo } from "@/lib/safe-next";
import { EmailVerificationNotice } from "@/components/EmailVerificationNotice";

// FR-1.4a: the invite accept page. Deliberately shows nothing about the wedding unless the
// invite is genuinely PENDING and (once we know who's signed in) the address matches -- an
// expired, revoked, already-accepted, or mismatched-account invite shows only that status.
export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  async function onSignOutAndReturn() {
    setSignOutError(null);
    try {
      await api.post("/api/v1/auth/logout");
    } catch {
      setSignOutError("Couldn't sign out — check your connection and try again.");
      return;
    }
    router.replace(loginUrlReturningTo(`/invites/${token}`));
  }

  const [preview, setPreview] = useState<InvitePreviewDTO | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TS-166: the invite couldn't be loaded (as opposed to not existing) -- shown with a Try again.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const [previewRes, meRes] = await Promise.all([
          api.get<{ invite: InvitePreviewDTO }>(`/api/v1/invites/${token}`),
          api.get<{ user: { email: string } }>("/api/v1/auth/me").catch(() => null),
        ]);
        setPreview(previewRes.invite);
        setCurrentUserEmail(meRes ? meRes.user.email : null);
      } catch (err) {
        // TS-166: a link that doesn't exist comes back as status NOT_FOUND, never an error -- an
        // error here is a failed load (connection, server, too many attempts), not a dead link.
        setLoadError(
          err instanceof ApiError && err.status !== 0
            ? err.message
            : "We couldn't load this invite just now. Check your connection and try again."
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [token, loadAttempt]);

  async function onAccept() {
    setError(null);
    setAccepting(true);
    try {
      const { weddingId } = await api.post<{ weddingId: string }>(`/api/v1/invites/${token}/accept`);
      router.push(`/weddings/${weddingId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't accept this invite.");
      setAccepting(false);
    }
  }

  if (loadError) {
    return (
      <main className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-sm text-center">
          <h1 className="mb-4 text-2xl font-semibold">Wedding invite</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">{loadError}</p>
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setLoading(true);
              setLoadAttempt((n) => n + 1);
            }}
            className="mt-4 rounded-md border border-neutral-300 dark:border-neutral-600 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (loading || !preview) {
    return <main className="flex flex-1 items-center justify-center text-neutral-500 dark:text-neutral-400">Loading...</main>;
  }

  const signedIn = currentUserEmail !== null && currentUserEmail !== undefined;

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="mb-4 text-2xl font-semibold">Wedding invite</h1>
        {/* TS-164: an account must confirm its email before it can accept. */}
        {signedIn && <EmailVerificationNotice />}

        {preview.status === "NOT_FOUND" && (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">This invite link doesn&apos;t exist.</p>
        )}
        {preview.status === "REVOKED" && (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">{/* TS-177: also what an older link shows once a newer invite was sent -- not only a cancelled one. */}
            This invite link is no longer active. If you were sent a newer invite, use the link in that email; otherwise
            ask the person who invited you for a new one.</p>
        )}
        {preview.status === "EXPIRED" && (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            This invite has expired. Ask the wedding&apos;s owner to send a new one.
          </p>
        )}
        {preview.status === "ACCEPTED" && (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">This invite has already been accepted.</p>
        )}
        {preview.status === "MISMATCHED_ACCOUNT" && (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              This invite was sent to a different email address than the account you&apos;re signed
              in with. Sign out and sign in with the invited address to accept it.
            </p>
            {/* TS-175: the button the message asks for -- signs out, then comes back here. */}
            <button
              type="button"
              onClick={() => void onSignOutAndReturn()}
              className="mt-4 rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300"
            >
              Sign out and use the invited address
            </button>
            {signOutError && (
              <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
                {signOutError}
              </p>
            )}
          </>
        )}

        {preview.status === "PENDING" && (
          <>
            <p className="mb-1 text-sm text-neutral-600 dark:text-neutral-300">
              You&apos;ve been invited to join <span className="font-medium">{preview.weddingName}</span>{" "}
              on Seatwise as {preview.role === "COUPLE" ? "a Couple member" : "a collaborator"}, with{" "}
              {preview.permissionLevel?.toLowerCase()} access.
            </p>
            {preview.invitedEmail ? (
              <p className="mb-6 break-all text-xs text-neutral-500 dark:text-neutral-400">Invited: {preview.invitedEmail}</p>
            ) : (
              <div className="mb-6" />
            )}

            {signedIn ? (
              <>
                {error && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
                <button
                  onClick={onAccept}
                  disabled={accepting}
                  className="w-full rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
                >
                  {accepting ? "Accepting..." : "Accept invite"}
                </button>
              </>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  Sign in or create an account with the email address this invite was sent to, to accept
                  it. You&apos;ll come straight back here afterwards.
                </p>
                <Link
                  href={loginUrlReturningTo(`/invites/${token}`)}
                  className="w-full rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300"
                >
                  Log in
                </Link>
                <Link href={`/signup?next=${encodeURIComponent(`/invites/${token}`)}`} className="text-sm underline">
                  Or create an account
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
