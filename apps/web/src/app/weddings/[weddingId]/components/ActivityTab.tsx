"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { ActivityEntryDTO } from "@seatwise/shared";

const ACTION_LABELS: Record<string, string> = {
  MANUAL_MOVE: "Moved",
  MANUAL_SWAP: "Swapped",
  STATUS_CHANGE: "Status change",
  ATTENDANCE_CHANGE: "Attendance",
  RESTORE: "Restored",
};

// FR-10.1: a single chronological log across every plan version of this wedding — who did what,
// and when, even for versions that are no longer Current.
export function ActivityTab({ weddingId }: { weddingId: string }) {
  const [entries, setEntries] = useState<ActivityEntryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ entries: ActivityEntryDTO[] }>(`/api/v1/weddings/${weddingId}/activity`)
      .then((res) => setEntries(res.entries))
      .catch(() => setError("Couldn't load the activity log."))
      .finally(() => setLoading(false));
  }, [weddingId]);

  if (loading) return <p className="text-sm text-neutral-500">Loading activity...</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;

  return (
    <div>
      <h2 className="mb-1 text-lg font-medium">Activity</h2>
      <p className="mb-4 text-sm text-neutral-500">
        Every change across every version of this wedding&apos;s seating plan, newest first.
      </p>
      {entries.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing has happened yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((e) => (
            <li key={e.id} className="rounded-lg border border-neutral-200 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {ACTION_LABELS[e.action] ?? e.action}
                  <span className="ml-2 font-normal text-neutral-500">v{e.versionNumber}</span>
                </span>
                <span className="text-xs text-neutral-400">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-700">{e.description}</p>
              {e.actorName && <p className="mt-1 text-xs text-neutral-400">by {e.actorName}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
