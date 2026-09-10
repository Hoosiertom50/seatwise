"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import type { GuestRsvpPreviewDTO } from "@seatwise/shared";

// TS-17 (FR-12.1/FR-12.2/FR-12.3): the guest's own RSVP page, reached via their unique
// unauthenticated link. No sign-in of any kind -- mirrors /invites/[token] structurally (a
// loading -> preview state machine) but the "preview" here doubles as the guest's own
// pre-filled answers (FR-12.2), and a successful submit re-fetches rather than navigating away,
// so re-opening this exact page always shows what's currently on file.
export default function GuestRsvpPage() {
  const { token } = useParams<{ token: string }>();

  const [preview, setPreview] = useState<GuestRsvpPreviewDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const [attending, setAttending] = useState<"CONFIRMED" | "DECLINED">("CONFIRMED");
  const [headcount, setHeadcount] = useState(1);
  const [plusOneNames, setPlusOneNames] = useState("");
  const [notes, setNotes] = useState("");
  const [requiresAccessibleTable, setRequiresAccessibleTable] = useState(false);

  async function load() {
    try {
      const res = await api.get<{ rsvp: GuestRsvpPreviewDTO }>(`/api/v1/rsvp/${token}`);
      setPreview(res.rsvp);
      if (res.rsvp.status !== "NOT_FOUND") {
        setAttending(res.rsvp.rsvpStatus === "DECLINED" ? "DECLINED" : "CONFIRMED");
        setHeadcount(res.rsvp.headcount ?? 1);
        setPlusOneNames(res.rsvp.plusOneNames ?? "");
        setNotes(res.rsvp.notes ?? "");
        setRequiresAccessibleTable(res.rsvp.requiresAccessibleTable ?? false);
      }
    } catch {
      setPreview({ status: "NOT_FOUND" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post(`/api/v1/rsvp/${token}`, {
        rsvpStatus: attending,
        headcount,
        plusOneNames: plusOneNames || null,
        notes: notes || null,
        requiresAccessibleTable,
      });
      setJustSubmitted(true);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't submit your RSVP.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || !preview) {
    return <main className="flex flex-1 items-center justify-center text-neutral-500 dark:text-neutral-400">Loading...</main>;
  }

  if (preview.status === "NOT_FOUND") {
    return (
      <main className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-sm text-center">
          <h1 className="mb-4 text-2xl font-semibold">RSVP</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">This RSVP link doesn&apos;t exist.</p>
        </div>
      </main>
    );
  }

  const closed = preview.status === "CLOSED";

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-10">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-2xl font-semibold">
          {preview.weddingName}
        </h1>
        <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">
          Hi {preview.firstName} — please let us know if you&apos;ll be able to join us.
        </p>

        {closed && (
          <p className="mb-6 rounded-md bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300">
            RSVP responses have closed
            {preview.rsvpCutoffDate ? ` (the deadline was ${preview.rsvpCutoffDate})` : ""}. Shown
            below is what&apos;s currently on file — contact the couple directly if anything needs
            to change.
          </p>
        )}
        {!closed && justSubmitted && (
          <p className="mb-6 rounded-md bg-green-50 dark:bg-green-950 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            Thanks — your RSVP has been recorded. You can come back to this link any time to update it.
          </p>
        )}

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <fieldset disabled={closed} className="flex flex-col gap-4 disabled:opacity-60">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAttending("CONFIRMED")}
                className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
                  attending === "CONFIRMED"
                    ? "border-neutral-900 dark:border-neutral-100 bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900"
                    : "border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300"
                }`}
              >
                Joyfully attending
              </button>
              <button
                type="button"
                onClick={() => setAttending("DECLINED")}
                className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
                  attending === "DECLINED"
                    ? "border-neutral-900 dark:border-neutral-100 bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900"
                    : "border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300"
                }`}
              >
                Regretfully declining
              </button>
            </div>

            {attending === "CONFIRMED" && (
              <>
                <label className="text-sm">
                  <span className="mb-1 block text-neutral-700 dark:text-neutral-300">Total in your party (including you)</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={headcount}
                    onChange={(e) => setHeadcount(Number(e.target.value))}
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                  />
                </label>

                {headcount > 1 && (
                  <label className="text-sm">
                    <span className="mb-1 block text-neutral-700 dark:text-neutral-300">Who&apos;s coming with you?</span>
                    <input
                      type="text"
                      value={plusOneNames}
                      onChange={(e) => setPlusOneNames(e.target.value)}
                      placeholder="e.g. Jamie Lee"
                      className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                    />
                  </label>
                )}

                <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={requiresAccessibleTable}
                    onChange={(e) => setRequiresAccessibleTable(e.target.checked)}
                  />
                  I (or someone in my party) need an accessible seat
                </label>
              </>
            )}

            <label className="text-sm">
              <span className="mb-1 block text-neutral-700 dark:text-neutral-300">
                Dietary restrictions or anything else we should know
              </span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              />
            </label>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 dark:hover:bg-neutral-300 disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit RSVP"}
            </button>
          </fieldset>
        </form>
      </div>
    </main>
  );
}
