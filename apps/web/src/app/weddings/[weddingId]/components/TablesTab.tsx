"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { GuestDTO, PlanVersionDTO, PlanVersionDetailDTO, SeatingTableDTO, TableShape } from "@seatwise/shared";

const SHAPES: TableShape[] = ["ROUND", "RECTANGULAR", "SQUARE", "OVAL", "OTHER"];

// FR-4.1: shape only ever affects this drawing -- never seating logic.
const SHAPE_STYLE: Record<TableShape, string> = {
  ROUND: "rounded-full",
  OVAL: "rounded-full",
  SQUARE: "rounded-md",
  RECTANGULAR: "rounded-md",
  OTHER: "rounded-sm border-dashed",
};

const BOX_SIZE = 96; // px -- the floor-plan table box's footprint, used for drag clamping

export function TablesTab({ weddingId, guests }: { weddingId: string; guests: GuestDTO[] }) {
  const [tables, setTables] = useState<SeatingTableDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "floorplan">("list");

  const [label, setLabel] = useState("");
  const [capacity, setCapacity] = useState(8);
  const [purpose, setPurpose] = useState("");
  const [isRestricted, setIsRestricted] = useState(false);
  const [isAccessible, setIsAccessible] = useState(false);
  const [shape, setShape] = useState<TableShape>("ROUND");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tableWarnings, setTableWarnings] = useState<string[]>([]);

  // FR-4.2: quick-create a standard set of tables in one action.
  const [qcCount, setQcCount] = useState(12);
  const [qcCapacity, setQcCapacity] = useState(8);
  const [qcShape, setQcShape] = useState<TableShape>("ROUND");
  const [qcPrefix, setQcPrefix] = useState("Table");
  const [qcCreating, setQcCreating] = useState(false);

  // FR-4.5: capacity overview needs the current plan version's assignments, purely to display --
  // never used for anything that affects seating logic.
  const [assignedHeadcountByTable, setAssignedHeadcountByTable] = useState<Record<string, number>>({});

  useEffect(() => {
    (async () => {
      try {
        const [tablesRes, versionsRes] = await Promise.all([
          api.get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`),
          api.get<{ planVersions: PlanVersionDTO[] }>(`/api/v1/weddings/${weddingId}/plan-versions`),
        ]);
        setTables(tablesRes.tables);
        const currentId = versionsRes.planVersions[0]?.id;
        if (currentId) {
          const detail = await api.get<{ planVersion: PlanVersionDetailDTO }>(
            `/api/v1/weddings/${weddingId}/plan-versions/${currentId}`
          );
          const byGuestId = new Map(guests.map((g) => [g.id, g]));
          const counts: Record<string, number> = {};
          for (const a of detail.planVersion.assignments) {
            const guest = byGuestId.get(a.guestId);
            if (!guest) continue;
            counts[a.tableId] = (counts[a.tableId] ?? 0) + guest.headcount;
          }
          setAssignedHeadcountByTable(counts);
        }
      } catch {
        setError("Couldn't load tables.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      const { table } = await api.post<{ table: SeatingTableDTO }>(
        `/api/v1/weddings/${weddingId}/tables`,
        { label, capacity, purpose: purpose || null, isRestricted, isAccessible, shape }
      );
      setTables([...tables, table].sort((a, b) => a.label.localeCompare(b.label)));
      setLabel("");
      setCapacity(8);
      setPurpose("");
      setIsRestricted(false);
      setIsAccessible(false);
      setShape("ROUND");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that table.");
    } finally {
      setAdding(false);
    }
  }

  async function onQuickCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setQcCreating(true);
    try {
      const { tables: created } = await api.post<{ tables: SeatingTableDTO[] }>(
        `/api/v1/weddings/${weddingId}/tables/quick-create`,
        { count: qcCount, capacity: qcCapacity, shape: qcShape, labelPrefix: qcPrefix }
      );
      setTables([...tables, ...created].sort((a, b) => a.label.localeCompare(b.label)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create those tables.");
    } finally {
      setQcCreating(false);
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

  // FR-4.6: unmarking (or re-marking) Accessible re-checks anyone currently seated here who
  // requires one -- the server flags/clears Needs Reassignment and keeps completeness in sync;
  // this just surfaces whatever warning message came back.
  async function onToggleAccessible(id: string, next: boolean) {
    const prev = tables;
    setTables(tables.map((t) => (t.id === id ? { ...t, isAccessible: next } : t)));
    try {
      const res = await api.patch<{ table: SeatingTableDTO; warnings: string[] }>(
        `/api/v1/weddings/${weddingId}/tables/${id}`,
        { isAccessible: next }
      );
      setTables((cur) => cur.map((t) => (t.id === id ? res.table : t)));
      setTableWarnings(res.warnings ?? []);
    } catch {
      setTables(prev);
      setError("Couldn't update that table's accessible flag.");
    }
  }

  async function onMove(id: string, x: number, y: number) {
    setTables((cur) => cur.map((t) => (t.id === id ? { ...t, positionX: x, positionY: y } : t)));
    try {
      await api.patch(`/api/v1/weddings/${weddingId}/tables/${id}`, { positionX: x, positionY: y });
    } catch {
      setError("Couldn't save that table's position.");
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading tables...</p>;

  const totalCapacity = tables.reduce((sum, t) => sum + t.capacity, 0);
  const attendingHeadcount = guests
    .filter((g) => g.dayOfAttendance === "ATTENDING")
    .reduce((sum, g) => sum + g.headcount, 0);
  const totalAssigned = Object.values(assignedHeadcountByTable).reduce((sum, n) => sum + n, 0);
  const shortfall = attendingHeadcount - totalCapacity;

  return (
    <div>
      <h2 className="mb-3 text-lg font-medium">Add a table</h2>
      <form
        onSubmit={onAdd}
        className="mb-6 grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 p-4 sm:grid-cols-2"
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
        <div>
          <label htmlFor="table-shape" className="mb-1 block text-sm font-medium">
            Shape
          </label>
          <select
            id="table-shape"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={shape}
            onChange={(e) => setShape(e.target.value as TableShape)}
          >
            {SHAPES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-neutral-500">Affects only the floor-plan drawing below.</p>
        </div>
        <div>
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
          Restricted (only guests on its required-guest list may be seated here)
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

      <details className="mb-6 rounded-lg border border-neutral-200 p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Quick-create a standard set of tables
        </summary>
        <form onSubmit={onQuickCreate} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor="qc-count" className="mb-1 block text-xs font-medium">
              How many
            </label>
            <input
              id="qc-count"
              type="number"
              min={1}
              max={100}
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={qcCount}
              onChange={(e) => setQcCount(Number(e.target.value))}
            />
          </div>
          <div>
            <label htmlFor="qc-capacity" className="mb-1 block text-xs font-medium">
              Seats each
            </label>
            <input
              id="qc-capacity"
              type="number"
              min={1}
              max={50}
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={qcCapacity}
              onChange={(e) => setQcCapacity(Number(e.target.value))}
            />
          </div>
          <div>
            <label htmlFor="qc-shape" className="mb-1 block text-xs font-medium">
              Shape
            </label>
            <select
              id="qc-shape"
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={qcShape}
              onChange={(e) => setQcShape(e.target.value as TableShape)}
            >
              {SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="qc-prefix" className="mb-1 block text-xs font-medium">
              Name prefix
            </label>
            <input
              id="qc-prefix"
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={qcPrefix}
              onChange={(e) => setQcPrefix(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={qcCreating}
            className="col-span-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 sm:col-span-4"
          >
            {qcCreating
              ? "Creating..."
              : `Create ${qcCount} ${qcShape.toLowerCase()} table(s) of ${qcCapacity}`}
          </button>
        </form>
      </details>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {tableWarnings.length > 0 && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {tableWarnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      {/* FR-4.5: capacity overview -- Attending count, assigned count, remaining capacity, and
          the exact shortfall when guests exceed capacity. Not Attending guests are excluded
          (attendingHeadcount already filters to dayOfAttendance === "ATTENDING"). */}
      <div className="mb-6 grid grid-cols-2 gap-3 rounded-lg border border-neutral-200 p-4 text-sm sm:grid-cols-4">
        <div>
          <p className="text-neutral-500">Attending</p>
          <p className="text-lg font-medium">{attendingHeadcount}</p>
        </div>
        <div>
          <p className="text-neutral-500">Total capacity</p>
          <p className="text-lg font-medium">{totalCapacity}</p>
        </div>
        <div>
          <p className="text-neutral-500">Assigned</p>
          <p className="text-lg font-medium">{totalAssigned}</p>
        </div>
        <div>
          <p className="text-neutral-500">Remaining capacity</p>
          <p className={`text-lg font-medium ${shortfall > 0 ? "text-red-600" : ""}`}>
            {totalCapacity - attendingHeadcount}
          </p>
        </div>
        {shortfall > 0 && (
          <p className="col-span-2 text-red-600 sm:col-span-4">
            Short {shortfall} seat(s) for everyone attending — add capacity or generation will
            report the shortfall rather than overfilling a table.
          </p>
        )}
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-medium">
          Tables ({tables.length}, {totalCapacity} seats)
        </h2>
        <div className="flex gap-1 rounded-md border border-neutral-300 p-0.5 text-sm">
          <button
            onClick={() => setView("list")}
            className={`rounded px-2 py-1 ${view === "list" ? "bg-neutral-900 text-white" : "hover:bg-neutral-50"}`}
          >
            List
          </button>
          <button
            onClick={() => setView("floorplan")}
            className={`rounded px-2 py-1 ${view === "floorplan" ? "bg-neutral-900 text-white" : "hover:bg-neutral-50"}`}
          >
            Floor plan
          </button>
        </div>
      </div>

      {tables.length === 0 ? (
        <p className="text-sm text-neutral-500">No tables yet — add your first one above.</p>
      ) : view === "floorplan" ? (
        <FloorPlan tables={tables} assignedHeadcountByTable={assignedHeadcountByTable} onMove={onMove} />
      ) : (
        <ul className="flex flex-col gap-2">
          {tables.map((t) => {
            const assigned = assignedHeadcountByTable[t.id] ?? 0;
            return (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 px-4 py-3"
              >
                <div>
                  <p className="font-medium">
                    {t.label}
                    <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
                      {t.shape.charAt(0) + t.shape.slice(1).toLowerCase()}
                    </span>
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
                    {assigned}/{t.capacity} seated ({t.capacity - assigned} remaining)
                    {t.purpose ? ` · ${t.purpose}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={t.isAccessible}
                      onChange={(e) => onToggleAccessible(t.id, e.target.checked)}
                    />
                    Accessible
                  </label>
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
            );
          })}
        </ul>
      )}
    </div>
  );
}

// FR-4.3: an optional visual floor plan -- dragging a table here only ever saves its (x, y)
// position for this view (and future exports); it never touches capacity, rules, or generation.
// Every table always has *some* position (a simple grid default assigned at creation time in the
// API), so there's no separate "unplaced" staging area to build here.
function FloorPlan({
  tables,
  assignedHeadcountByTable,
  onMove,
}: {
  tables: SeatingTableDTO[];
  assignedHeadcountByTable: Record<string, number>;
  onMove: (id: string, x: number, y: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>({});

  function positionFor(t: SeatingTableDTO): { x: number; y: number } {
    return localPositions[t.id] ?? { x: t.positionX ?? 40, y: t.positionY ?? 40 };
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>, t: SeatingTableDTO) {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    dragId.current = t.id;
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragId.current || !containerRef.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    let x = e.clientX - containerRect.left - dragOffset.current.x;
    let y = e.clientY - containerRect.top - dragOffset.current.y;
    x = Math.max(0, Math.min(x, containerRect.width - BOX_SIZE));
    y = Math.max(0, Math.min(y, containerRect.height - BOX_SIZE));
    setLocalPositions((prev) => ({ ...prev, [dragId.current!]: { x, y } }));
  }

  function onPointerUp() {
    if (!dragId.current) return;
    const id = dragId.current;
    const pos = localPositions[id];
    dragId.current = null;
    if (pos) onMove(id, Math.round(pos.x), Math.round(pos.y));
  }

  const width = Math.max(760, ...tables.map((t) => positionFor(t).x + BOX_SIZE + 40));
  const height = Math.max(520, ...tables.map((t) => positionFor(t).y + BOX_SIZE + 40));

  return (
    <div>
      <p className="mb-2 text-sm text-neutral-500">
        Drag a table to arrange the room. Position is saved automatically and never affects
        seating rules or generation.
      </p>
      <div
        ref={containerRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ width: "100%", height, maxWidth: width }}
        className="relative overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50"
      >
        {tables.map((t) => {
          const pos = positionFor(t);
          const assigned = assignedHeadcountByTable[t.id] ?? 0;
          const over = assigned > t.capacity;
          return (
            <div
              key={t.id}
              onPointerDown={(e) => onPointerDown(e, t)}
              style={{ left: pos.x, top: pos.y, width: BOX_SIZE, height: BOX_SIZE }}
              className={`absolute flex cursor-grab select-none flex-col items-center justify-center border-2 bg-white p-1 text-center text-xs shadow-sm active:cursor-grabbing ${
                SHAPE_STYLE[t.shape]
              } ${over ? "border-red-400" : t.isAccessible ? "border-blue-400" : "border-neutral-300"}`}
              title={`${t.label} — ${t.capacity} seats${t.purpose ? ` (${t.purpose})` : ""}`}
            >
              <span className="line-clamp-2 font-medium leading-tight">{t.label}</span>
              <span className="text-neutral-500">
                {assigned}/{t.capacity}
              </span>
              {t.isRestricted && <span className="text-[10px] text-amber-700">restricted</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
