"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import type { InvitePreviewDTO } from "@seatwise/shared";

// FR-1.4a: the invite accept page. Deliberately shows nothing about the wedding unless the
// invite is genuinely PENDING and (once we know who's signed in) the address matches -- an
// expired, revoked, already-accepted, or mismatched-account invite shows only that status.
export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();

  const [preview, setPreview] = useState<InvitePreviewDTO | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [previewRes, meRes] = await Promise.all([
          api.get<{ invite: InvitePreviewDTO }>(`/api/v1/invites/${token}`),
          api.get<{ user: { email: string } }>("/api/v1/auth/me").catch(() => null),
        ]);
        setPreview(previewRes.invite);
        setCurrentUserEmail(meRes ? meRes.user.email : null);
      } catch {
        setPreview({ status: "NOT_FOUND" });
        setCurrentUserEmail(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

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

  if (loading || !preview) {
    return <main className="flex flex-1 items-center justify-center text-neutral-500">Loading...</main>;
  }

  const signedIn = currentUserEmail !== null && currentUserEmail !== undefined;

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="mb-4 text-2xl font-semibold">Wedding invite</h1>

        {preview.status === "NOT_FOUND" && (
          <p className="text-sm text-neutral-600">This invite link doesn&apos;t exist.</p>
        )}
        {preview.status === "REVOKED" && (
          <p className="text-sm text-neutral-600">This invite has been revoked by the wedding&apos;s owner.</p>
        )}
        {preview.status === "EXPIRED" && (
          <p className="text-sm text-neutral-600">
            This invite has expired. Ask the wedding&apos;s owner to send a new one.
          </p>
        )}
        {preview.status === "ACCEPTED" && (
          <p className="text-sm text-neutral-600">This invite has already been accepted.</p>
        )}
        {preview.status === "MISMATCHED_ACCOUNT" && (
          <p className="text-sm text-neutral-600">
            This invite was sent to a different email address than the account you&apos;re signed
            in with. Sign out and sign in with the invited address to accept it.
          </p>
        )}

        {preview.status === "PENDING" && (
          <>
            <p className="mb-1 text-sm text-neutral-600">
              You&apos;ve been invited to join <span className="font-medium">{preview.weddingName}</span>{" "}
              on Seatwise as {preview.role === "COUPLE" ? "a Couple member" : "a collaborator"}, with{" "}
              {preview.permissionLevel?.toLowerCase()} access.
            </p>
            <p className="mb-6 text-xs text-neutral-400">Invited: {preview.invitedEmail}</p>

            {signedIn ? (
              <>
                {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
                <button
                  onClick={onAccept}
                  disabled={accepting}
                  className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
                >
                  {accepting ? "Accepting..." : "Accept invite"}
                </button>
              </>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-neutral-500">
                  Sign in or create an account with {preview.invitedEmail} to accept — then come
                  back to this link.
                </p>
                <Link
                  href="/login"
                  className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
                >
                  Log in
                </Link>
                <Link href="/signup" className="text-sm underline">
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
