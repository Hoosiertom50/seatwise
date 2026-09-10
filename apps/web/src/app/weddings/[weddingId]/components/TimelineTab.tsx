"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { TimelineEntryDTO } from "@seatwise/shared";

// TS-18 (Day-Of Timeline / Run-of-Show, FR-13.1/FR-13.2): a per-wedding, chronological schedule of
// day-of events -- its own record, entirely independent of guests/tables/rules/seating plans.
// Entries are always listed by (time, sortOrder) from the server, so this component never sorts
// client-side; "reorder" only ever moves an entry among others sharing its exact same time.
export function TimelineTab({ weddingId, canEdit }: { weddingId: string; canEdit: boolean }) {
  const [entries, setEntries] = useState<TimelineEntryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [time, setTime] = useState("");
  const [description, setDescription] = useState("");
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTime, setEditTime] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<{ entries: TimelineEntryDTO[] }>(`/api/v1/weddings/${weddingId}/timeline-entries`)
      .then((res) => setEntries(res.entries))
      .catch(() => setError("Couldn't load the timeline."))
      .finally(() => setLoading(false));
  }, [weddingId]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      const { entry } = await api.post<{ entry: TimelineEntryDTO }>(
        `/api/v1/weddings/${weddingId}/timeline-entries`,
        { time, description }
      );
      setEntries(
        [...entries, entry].sort((a, b) => a.time.localeCompare(b.time) || a.sortOrder - b.sortOrder)
      );
      setTime("");
      setDescription("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that timeline entry.");
    } finally {
      setAdding(false);
    }
  }

  function startEdit(entry: TimelineEntryDTO) {
    setEditingId(entry.id);
    setEditTime(entry.time);
    setEditDescription(entry.description);
  }

  async function onSaveEdit(entryId: string) {
    setSaving(true);
    setError(null);
    try {
      const { entry } = await api.patch<{ entry: TimelineEntryDTO }>(
        `/api/v1/weddings/${weddingId}/timeline-entries/${entryId}`,
        { time: editTime, description: editDescription }
      );
      setEntries(
        entries
          .map((e) => (e.id === entryId ? entry : e))
          .sort((a, b) => a.time.localeCompare(b.time) || a.sortOrder - b.sortOrder)
      );
      setEditingId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that change.");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(entryId: string) {
    const prev = entries;
    setEntries(entries.filter((e) => e.id !== entryId));
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/timeline-entries/${entryId}`);
    } catch {
      setEntries(prev);
      setError("Couldn't remove that timeline entry.");
    }
  }

  // FR-13.2: only ever reshuffles entries that share this entry's exact same time -- a no-op
  // (entry unchanged) if it's already first/last within that tied group.
  async function onReorder(entryId: string, direction: "UP" | "DOWN") {
    setError(null);
    try {
      const { entry } = await api.post<{ entry: TimelineEntryDTO }>(
        `/api/v1/weddings/${weddingId}/timeline-entries/${entryId}/reorder`,
        { direction }
      );
      // The move can affect two rows (this one and its swapped neighbor) -- simplest correct
      // approach is to refetch the full list rather than guess at the neighbor's new sortOrder.
      const res = await api.get<{ entries: TimelineEntryDTO[] }>(
        `/api/v1/weddings/${weddingId}/timeline-entries`
      );
      setEntries(res.entries);
      void entry;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reorder that entry.");
    }
  }

  function formatTime(hhmm: string): string {
    const [h, m] = hhmm.split(":").map(Number);
    const period = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${period}`;
  }

  if (loading) return <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading timeline...</p>;

  return (
    <div>
      {!canEdit && (
        <p className="mb-4 rounded-md bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300">
          You have view-only access to this wedding's timeline — adding, editing, and reordering
          entries is turned off.
        </p>
      )}
      {canEdit && (
        <>
          <h2 className="mb-3 text-lg font-medium">Add a timeline entry</h2>
          <form
            onSubmit={onAdd}
            className="mb-8 grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 sm:grid-cols-[auto_1fr]"
          >
            <div>
              <label htmlFor="entry-time" className="mb-1 block text-sm font-medium">
                Time
              </label>
              <input
                id="entry-time"
                type="time"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="entry-description" className="mb-1 block text-sm font-medium">
                Event
              </label>
              <input
                id="entry-description"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                placeholder="e.g. Ceremony begins"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>
            <button
              type="submit"
              disabled={adding}
              className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50 sm:col-span-2"
            >
              {adding ? "Adding..." : "Add to timeline"}
            </button>
          </form>
        </>
      )}

      {error && <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <h2 className="mb-3 text-lg font-medium">Run of show ({entries.length})</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No timeline entries yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry, i) => {
            const sameTimeAbove = i > 0 && entries[i - 1].time === entry.time;
            const sameTimeBelow = i < entries.length - 1 && entries[i + 1].time === entry.time;
            return (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3"
              >
                {editingId === entry.id ? (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <input
                      type="time"
                      aria-label="Edit time"
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={editTime}
                      onChange={(e) => setEditTime(e.target.value)}
                    />
                    <input
                      aria-label="Edit description"
                      className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                    />
                    <button
                      onClick={() => onSaveEdit(entry.id)}
                      disabled={saving}
                      className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-3 py-1.5 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div>
                      <p className="font-medium">{formatTime(entry.time)}</p>
                      <p className="text-sm text-neutral-500 dark:text-neutral-400">{entry.description}</p>
                    </div>
                    {canEdit && (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => onReorder(entry.id, "UP")}
                          disabled={!sameTimeAbove}
                          title="Move earlier among entries at this same time"
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => onReorder(entry.id, "DOWN")}
                          disabled={!sameTimeBelow}
                          title="Move later among entries at this same time"
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => startEdit(entry)}
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => onDelete(entry.id)}
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
