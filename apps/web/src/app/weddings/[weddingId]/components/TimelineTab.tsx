"use client";

import { useEffect, useRef, useState } from "react";
import { ConfirmDeleteButton } from "@/components/ConfirmDeleteButton";
import { api, ApiError, apiErrorMessage } from "@/lib/api-client";
import type { TimelineEntryDTO } from "@seatwise/shared";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { OPEN_EDIT_MESSAGE, REFRESH_FAILED_MESSAGE } from "@/lib/display-format";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

// TS-18 (Day-Of Timeline / Run-of-Show, FR-13.1/FR-13.2): a per-wedding, chronological schedule of
// day-of events -- its own record, entirely independent of guests/tables/rules/seating plans.
// Entries are always listed by (time, sortOrder) from the server, so this component never sorts
// client-side; "reorder" only ever moves an entry among others sharing its exact same time.
// TS-212: after the edit box swaps back to the row (Save, Cancel), or opens, focus goes to a stable
// control by id -- it used to drop to the page, so the next Tab started from the top. Only if focus
// was lost (someone who has clicked elsewhere keeps their place).
function focusIfLost(id: string) {
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    document.getElementById(id)?.focus();
  }, 0);
}

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
  // TS-159: tell the page this tab has input that leaving it would lose.
  // TS-166: a time picked for a new entry counts too.
  // TS-175: an open edit box counts only once something in it has changed.
  const editingEntry = entries.find((e) => e.id === editingId);
  const editChanged = !!editingEntry && (editTime !== editingEntry.time || editDescription !== editingEntry.description);
  // TS-182: only while the forms are there (they're hidden without Edit access).
  useUnsavedChanges("timeline", canEdit && !!(time || description.trim() || editChanged));
  const [saving, setSaving] = useState(false);
  // TS-191: a reorder is on its way -- the arrows wait for it (quick presses used to send moves
  // based on an order that was about to change).
  const [reordering, setReordering] = useState(false);
  // TS-191: Edit access taken away while an entry's edit was open -- it can't be saved any more,
  // so it closes (and stops counting as unsaved).
  useEffect(() => {
    if (canEdit) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TS-191: closes the edit box when Edit access goes.
    setEditingId(null);
  }, [canEdit]);

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
      // TS-166: built from the list as it is now, so another change made meanwhile isn't lost.
      listChange.current++; // TS-199
      setEntries((cur) =>
        [...cur, entry].sort((a, b) => a.time.localeCompare(b.time) || a.sortOrder - b.sortOrder)
      );
      setTime("");
      setDescription("");
    } catch (err) {
      setError(apiErrorMessage(err, [], "Couldn't add that timeline entry."));
    } finally {
      setAdding(false);
    }
  }

  function startEdit(entry: TimelineEntryDTO) {
    // TS-182: opening another entry used to throw away a changed open edit without a word.
    if (editChanged && editingId !== entry.id) {
      setError(OPEN_EDIT_MESSAGE);
      return;
    }
    setError(null);
    setEditingId(entry.id);
    setEditTime(entry.time);
    setEditDescription(entry.description);
    focusIfLost(`timeline-${entry.id}-edit-time`);
  }

  async function onSaveEdit(entryId: string) {
    setSaving(true);
    setError(null);
    try {
      const { entry } = await api.patch<{ entry: TimelineEntryDTO }>(
        `/api/v1/weddings/${weddingId}/timeline-entries/${entryId}`,
        {
          time: editTime,
          description: editDescription,
          // TS-92: the version this edit is based on -- a stale one is refused, never overwrites.
          expectedRevision: entries.find((e) => e.id === entryId)?.revision,
        }
      );
      // TS-182: applied to the list as it is now, so an entry added or removed meanwhile stays.
      listChange.current++; // TS-199
      setEntries((cur) =>
        cur
          .map((e) => (e.id === entryId ? entry : e))
          .sort((a, b) => a.time.localeCompare(b.time) || a.sortOrder - b.sortOrder)
      );
      setEditingId(null);
      // TS-212: back to this entry's Edit button (wherever the new time put it).
      focusIfLost(`timeline-${entryId}-edit`);
    } catch (err) {
      // TS-92: someone else changed this entry first. Show their version and say plainly that
      // this edit was not saved -- the edit box closes so the stale text can't be mistaken for
      // what's on record.
      const fresh = err instanceof ApiError && err.status === 409 ? (err.data?.entry as TimelineEntryDTO | undefined) : undefined;
      if (fresh) {
        setEntries((cur) =>
          cur
            .map((e) => (e.id === entryId ? fresh : e))
            .sort((a, b) => a.time.localeCompare(b.time) || a.sortOrder - b.sortOrder)
        );
        setEditingId(null);
        focusIfLost(`timeline-${entryId}-edit`);
      }
      setError(apiErrorMessage(err, [], "Couldn't save that change."));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(entryId: string) {
    const removed = entries.find((e) => e.id === entryId);
    setEntries((cur) => cur.filter((e) => e.id !== entryId));
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/timeline-entries/${entryId}`);
      listChange.current++; // TS-199
    } catch {
      if (removed)
        setEntries((cur) =>
          [...cur, removed].sort((a, b) => a.time.localeCompare(b.time) || a.sortOrder - b.sortOrder)
        );
      setError("Couldn't remove that timeline entry.");
    }
  }

  // FR-13.2: only ever reshuffles entries that share this entry's exact same time -- a no-op
  // (entry unchanged) if it's already first/last within that tied group.
  async function onReorder(entryId: string, direction: "UP" | "DOWN") {
    if (reordering) return;
    setError(null);
    setReordering(true);
    try {
      await reorderAndReload(entryId, direction);
    } finally {
      setReordering(false);
      // TS-199: an arrow that can't be used any more (the entry is now first or last at its time)
      // is turned off, which dropped keyboard focus to the top of the page. Focus goes to the
      // entry's other arrow instead.
      setTimeout(() => {
        const pressed = document.getElementById(`timeline-${entryId}-${direction}`) as HTMLButtonElement | null;
        const other = document.getElementById(`timeline-${entryId}-${direction === "UP" ? "DOWN" : "UP"}`) as HTMLButtonElement | null;
        const active = document.activeElement;
        const lost = !active || active === document.body || !active.isConnected;
        if (pressed && !pressed.disabled) {
          if (lost) pressed.focus();
        } else if (other && !other.disabled && (lost || active === pressed)) other.focus();
      }, 0);
    }
  }

  // TS-199: each change to the list gets a number; a reload that comes back after a newer change
  // (an edit, an add or a remove made while it was on its way) is dropped instead of putting the
  // older list back over it.
  const listChange = useRef(0);

  async function reorderAndReload(entryId: string, direction: "UP" | "DOWN") {
    try {
      await api.post<{ entry: TimelineEntryDTO }>(
        `/api/v1/weddings/${weddingId}/timeline-entries/${entryId}/reorder`,
        { direction }
      );
    } catch (err) {
      setError(apiErrorMessage(err, [], "Couldn't reorder that entry."));
      return;
    }
    // The move can affect two rows (this one and its swapped neighbor) -- simplest correct
    // approach is to refetch the full list rather than guess at the neighbor's new sortOrder.
    // TS-182: in its own try -- the move was saved even if this reload fails, and it used to say
    // "Couldn't reorder" when it had.
    // TS-199: if something newer changed the list meanwhile, this answer is out of date -- ask again
    // (a fresh answer has both changes) rather than show it.
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const seq = ++listChange.current;
        const res = await api.get<{ entries: TimelineEntryDTO[] }>(
          `/api/v1/weddings/${weddingId}/timeline-entries`
        );
        if (seq === listChange.current) {
          setEntries(res.entries);
          return;
        }
      }
    } catch {
      setError(REFRESH_FAILED_MESSAGE);
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
          You have view-only access to this wedding&apos;s timeline — adding, editing, and reordering
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
                maxLength={FIELD_LIMITS.timelineDescription}
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

      {error && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

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
                      id={`timeline-${entry.id}-edit-time`}
                      type="time"
                      aria-label="Edit time"
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={editTime}
                      onChange={(e) => setEditTime(e.target.value)}
                    />
                    <input
                      maxLength={FIELD_LIMITS.timelineDescription}
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
                      onClick={() => {
                        setEditingId(null);
                        focusIfLost(`timeline-${entry.id}-edit`);
                      }}
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    {/* TS-199: a long description wraps instead of pushing the row off a phone screen. */}
                    <div className="min-w-0">
                      <p className="font-medium">{formatTime(entry.time)}</p>
                      <p className="break-words text-sm text-neutral-500 dark:text-neutral-400 [overflow-wrap:anywhere]">{entry.description}</p>
                    </div>
                    {canEdit && (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          id={`timeline-${entry.id}-UP`}
                          onClick={() => onReorder(entry.id, "UP")}
                          disabled={!sameTimeAbove}
                          // TS-191: busy while a reorder is on its way (still focusable, so the keyboard keeps its place)
                          aria-disabled={reordering || undefined}
                          // TS-175: names that say which entry, for screen readers ("↑" alone said nothing).
                          aria-label={`Move ${entry.description} earlier`}
                          title="Move earlier among entries at this same time"
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-30 aria-disabled:opacity-50"
                        >
                          ↑
                        </button>
                        <button
                          id={`timeline-${entry.id}-DOWN`}
                          onClick={() => onReorder(entry.id, "DOWN")}
                          disabled={!sameTimeBelow}
                          aria-disabled={reordering || undefined}
                          aria-label={`Move ${entry.description} later`}
                          title="Move later among entries at this same time"
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-30 aria-disabled:opacity-50"
                        >
                          ↓
                        </button>
                        <button
                          id={`timeline-${entry.id}-edit`}
                          onClick={() => startEdit(entry)}
                          aria-label={`Edit ${entry.description}`}
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        >
                          Edit
                        </button>
                        <ConfirmDeleteButton
                          id={`timeline-${entry.id}-remove`}
                          ariaLabel={`Remove ${entry.description}`}
                          question={`Remove "${entry.description}" from the timeline? This can't be undone.`}
                          confirmLabel="Yes, remove entry"
                          onConfirm={() => onDelete(entry.id)}
                        />
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
