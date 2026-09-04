"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { SeatingTableDTO } from "@seatwise/shared";

export function TablesTab({ weddingId }: { weddingId: string }) {
  const [tables, setTables] = useState<SeatingTableDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [capacity, setCapacity] = useState(8);
  const [purpose, setPurpose] = useState("");
  const [isRestricted, setIsRestricted] = useState(false);
  const [isAccessible, setIsAccessible] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`)
      .then((res) => setTables(res.tables))
      .catch(() => setError("Couldn't load tables."))
      .finally(() => setLoading(false));
  }, [weddingId]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      const { table } = await api.post<{ table: SeatingTableDTO }>(
        `/api/v1/weddings/${weddingId}/tables`,
        { label, capacity, purpose: purpose || null, isRestricted, isAccessible }
      );
      setTables([...tables, table].sort((a, b) => a.label.localeCompare(b.label)));
      setLabel("");
      setCapacity(8);
      setPurpose("");
      setIsRestricted(false);
      setIsAccessible(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that table.");
    } finally {
      setAdding(false);
    }
  }

  async function onRemove(id: string) {
    const prev = tables;
    setTables(tables.filter((t) => t.id !== id));
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/tables/${id}`);
    } catch {
      setTables(prev);
      setError("Couldn't remove that table.");
    }
  }

  async function onToggleLock(id: string, isLocked: boolean) {
    const prev = tables;
    setTables(tables.map((t) => (t.id === id ? { ...t, isLocked } : t)));
    try {
      await api.patch(`/api/v1/weddings/${weddingId}/tables/${id}`, { isLocked });
    } catch {
      setTables(prev);
      setError("Couldn't update that table's lock.");
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading tables...</p>;

  const totalCapacity = tables.reduce((sum, t) => sum + t.capacity, 0);

  return (
    <div>
      <h2 className="mb-3 text-lg font-medium">Add a table</h2>
      <form
        onSubmit={onAdd}
        className="mb-8 grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 p-4 sm:grid-cols-2"
      >
        <div>
          <label htmlFor="table-name" className="mb-1 block text-sm font-medium">
            Table name
          </label>
          <input
            id="table-name"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder="Table 1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="table-capacity" className="mb-1 block text-sm font-medium">
            Capacity
          </label>
          <input
            id="table-capacity"
            type="number"
            min={1}
            max={50}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="table-purpose" className="mb-1 block text-sm font-medium">
            Purpose (optional)
          </label>
          <input
            id="table-purpose"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder="e.g. Kids table, Head table"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={isRestricted}
            onChange={(e) => setIsRestricted(e.target.checked)}
          />
          Restricted (only specific guests may be seated here — excluded from auto-assignment for now)
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={isAccessible}
            onChange={(e) => setIsAccessible(e.target.checked)}
          />
          Accessible (wheelchair-accessible seating)
        </label>
        <button
          type="submit"
          disabled={adding}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 sm:col-span-2"
        >
          {adding ? "Adding..." : "Add table"}
        </button>
      </form>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <h2 className="mb-3 text-lg font-medium">
        Tables ({tables.length}, {totalCapacity} seats)
      </h2>
      {tables.length === 0 ? (
        <p className="text-sm text-neutral-500">No tables yet — add your first one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tables.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3"
            >
              <div>
                <p className="font-medium">
                  {t.label}
                  {t.isRestricted && (
                    <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                      restricted
                    </span>
                  )}
                  {t.isAccessible && (
                    <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                      accessible
                    </span>
                  )}
                  {t.isLocked && (
                    <span
                      className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-white"
                      title="Locked — automated seating won't assign new guests here."
                    >
                      locked
                    </span>
                  )}
                </p>
                <p className="text-sm text-neutral-500">
                  Seats {t.capacity}
                  {t.purpose ? ` · ${t.purpose}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onToggleLock(t.id, !t.isLocked)}
                  title="Locking reserves this table for its current guests during automated seating."
                  className="rounded-md border border-neutral-300 px-2 py-1 text-sm hover:bg-neutral-50"
                >
                  {t.isLocked ? "Unlock" : "Lock"}
                </button>
                <button
                  onClick={() => onRemove(t.id)}
                  className="rounded-md border border-neutral-300 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
