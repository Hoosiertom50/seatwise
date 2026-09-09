"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type {
  GuestDTO,
  PlanVersionDTO,
  PlanVersionDetailDTO,
  SeatingTableDTO,
  SeatingTemplateDTO,
  TableShape,
  TablePurposeCriterionType,
  WeddingDTO,
} from "@seatwise/shared";

const SHAPES: TableShape[] = ["ROUND", "RECTANGULAR", "SQUARE", "OVAL", "OTHER"];

// FR-3.7: which structured criterion (if any) a Purpose table favors as a soft preference --
// "None" means it's just a free-text label with no algorithmic effect, same as before this field
// existed.
const CRITERION_TYPES: { value: TablePurposeCriterionType | ""; label: string }[] = [
  { value: "", label: "None (label only)" },
  { value: "SIDE", label: "Side" },
  { value: "TIER", label: "Relationship tier" },
  { value: "AGE_CATEGORY", label: "Age category" },
];
const TIER_VALUES = ["VIP", "FAMILY", "FRIEND", "PLUS_ONE", "OTHER"] as const;
const AGE_CATEGORY_VALUES = ["ADULT", "CHILD", "INFANT"] as const;

// FR-3.7: a human-readable label for a Purpose table's criterion value, in the badge shown on
// each table row -- `sideValues` carries this wedding's own side labels (FR-1.3a) rather than a
// hardcoded "Bride"/"Groom".
function criterionValueLabel(
  type: TablePurposeCriterionType,
  value: string | null,
  sideValues: { value: string; label: string }[]
): string {
  if (!value) return "";
  if (type === "SIDE") return sideValues.find((o) => o.value === value)?.label ?? value;
  if (type === "TIER") return value.replace("_", " ");
  return value.charAt(0) + value.slice(1).toLowerCase();
}

// FR-4.1: shape only ever affects this drawing -- never seating logic.
const SHAPE_STYLE: Record<TableShape, string> = {
  ROUND: "rounded-full",
  OVAL: "rounded-full",
  SQUARE: "rounded-md",
  RECTANGULAR: "rounded-md",
  OTHER: "rounded-sm border-dashed",
};

const BOX_SIZE = 96; // px -- the floor-plan table box's footprint, used for drag clamping

export function TablesTab({
  weddingId,
  wedding,
  guests,
  canEdit,
}: {
  weddingId: string;
  wedding: WeddingDTO | null;
  guests: GuestDTO[];
  canEdit: boolean;
}) {
  const sideLabel1 = wedding?.sideLabel1 ?? "Bride";
  const sideLabel2 = wedding?.sideLabel2 ?? "Groom";
  // FR-1.3a: BRIDE/GROOM/BOTH are the stored values -- these are only the labels shown for a
  // Side criterion's value picker, mirroring GuestsTab's own SIDE_OPTIONS.
  const SIDE_VALUES: { value: string; label: string }[] = [
    { value: "BRIDE", label: sideLabel1 },
    { value: "GROOM", label: sideLabel2 },
    { value: "BOTH", label: "Both" },
  ];

  const [tables, setTables] = useState<SeatingTableDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "floorplan">("list");

  const [label, setLabel] = useState("");
  const [capacity, setCapacity] = useState(8);
  const [purpose, setPurpose] = useState("");
  const [isRestricted, setIsRestricted] = useState(false);
  const [isAccessible, setIsAccessible] = useState(false);
  const [singleSideOnly, setSingleSideOnly] = useState(false);
  const [criterionType, setCriterionType] = useState<TablePurposeCriterionType | "">("");
  const [criterionValue, setCriterionValue] = useState("");
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

  // TS-19 (FR-14.1/FR-14.2): save this wedding's current table layout + Side-Mixing setting as a
  // reusable template -- see save-as-template's own route comment for why EDIT access is enough.
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [savedTemplate, setSavedTemplate] = useState<SeatingTemplateDTO | null>(null);

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
        // FR-5.6 (TS-8): a Comparison Draft can have a higher versionNumber than Current without
        // replacing it, so the first (newest) row here isn't reliably Current anymore -- the
        // capacity overview must reflect Current's assignments specifically, by isCurrent.
        const currentId =
          versionsRes.planVersions.find((v) => v.isCurrent)?.id ?? versionsRes.planVersions[0]?.id;
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
        {
          label,
          capacity,
          purpose: purpose || null,
          isRestricted,
          isAccessible,
          singleSideOnly,
          purposeCriterionType: criterionType || null,
          purposeCriterionValue: criterionType ? criterionValue : null,
          shape,
        }
      );
      setTables([...tables, table].sort((a, b) => a.label.localeCompare(b.label)));
      setLabel("");
      setCapacity(8);
      setPurpose("");
      setIsRestricted(false);
      setIsAccessible(false);
      setSingleSideOnly(false);
      setCriterionType("");
      setCriterionValue("");
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

  // TS-19: captures the tables above plus this wedding's sideMixing setting in one action. A
  // template is a one-time snapshot, not a live link -- editing this wedding's tables afterward
  // never changes a template already saved from it.
  async function onSaveAsTemplate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedTemplate(null);
    setSavingTemplate(true);
    try {
      const { template } = await api.post<{ template: SeatingTemplateDTO }>(
        `/api/v1/weddings/${weddingId}/save-as-template`,
        { name: templateName }
      );
      setSavedTemplate(template);
      setTemplateName("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that template.");
    } finally {
      setSavingTemplate(false);
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

  // FR-7.7, extended to seating tables: a 409 conflict carries the fresh, currently-committed
  // table alongside the message -- pulling it out lets every edit handler refresh that one row in
  // one step instead of a second round-trip, and shows the user the latest instead of a bare error.
  function conflictTable(err: unknown): SeatingTableDTO | null {
    if (err instanceof ApiError && err.status === 409 && err.data?.table) {
      return err.data.table as SeatingTableDTO;
    }
    return null;
  }

  async function onToggleLock(id: string, isLocked: boolean) {
    const prev = tables;
    const expectedRevision = prev.find((t) => t.id === id)?.revision;
    setTables(prev.map((t) => (t.id === id ? { ...t, isLocked } : t)));
    try {
      const { table } = await api.patch<{ table: SeatingTableDTO }>(
        `/api/v1/weddings/${weddingId}/tables/${id}`,
        { isLocked, expectedRevision }
      );
      setTables(prev.map((t) => (t.id === id ? table : t)));
    } catch (err) {
      const fresh = conflictTable(err);
      if (fresh) {
        setTables(prev.map((t) => (t.id === id ? fresh : t)));
        setError(`"${fresh.label}" was just edited elsewhere — showing the latest. Try again if you still want to make this change.`);
      } else {
        setTables(prev);
        setError(err instanceof ApiError ? err.message : "Couldn't update that table's lock.");
      }
    }
  }

  // FR-4.6: unmarking (or re-marking) Accessible re-checks anyone currently seated here who
  // requires one -- the server flags/clears Needs Reassignment and keeps completeness in sync;
  // this just surfaces whatever warning message came back.
  async function onToggleAccessible(id: string, next: boolean) {
    const prev = tables;
    const expectedRevision = prev.find((t) => t.id === id)?.revision;
    setTables(prev.map((t) => (t.id === id ? { ...t, isAccessible: next } : t)));
    try {
      const res = await api.patch<{ table: SeatingTableDTO; warnings: string[] }>(
        `/api/v1/weddings/${weddingId}/tables/${id}`,
        { isAccessible: next, expectedRevision }
      );
      setTables((cur) => cur.map((t) => (t.id === id ? res.table : t)));
      setTableWarnings(res.warnings ?? []);
    } catch (err) {
      const fresh = conflictTable(err);
      if (fresh) {
        setTables(prev.map((t) => (t.id === id ? fresh : t)));
        setError(`"${fresh.label}" was just edited elsewhere — showing the latest. Try again if you still want to make this change.`);
      } else {
        setTables(prev);
        setError(err instanceof ApiError ? err.message : "Couldn't update that table's accessible flag.");
      }
    }
  }

  // FR-3.4: a plain boolean toggle, same pattern as isLocked -- unlike isAccessible it never has
  // a hard-rule reassignment side effect, so there's nothing else to surface here.
  async function onToggleSingleSideOnly(id: string, next: boolean) {
    const prev = tables;
    const expectedRevision = prev.find((t) => t.id === id)?.revision;
    setTables(prev.map((t) => (t.id === id ? { ...t, singleSideOnly: next } : t)));
    try {
      const { table } = await api.patch<{ table: SeatingTableDTO }>(
        `/api/v1/weddings/${weddingId}/tables/${id}`,
        { singleSideOnly: next, expectedRevision }
      );
      setTables(prev.map((t) => (t.id === id ? table : t)));
    } catch (err) {
      const fresh = conflictTable(err);
      if (fresh) {
        setTables(prev.map((t) => (t.id === id ? fresh : t)));
        setError(`"${fresh.label}" was just edited elsewhere — showing the latest. Try again if you still want to make this change.`);
      } else {
        setTables(prev);
        setError(err instanceof ApiError ? err.message : "Couldn't update that table's Single-Side-Only setting.");
      }
    }
  }

  async function onMove(id: string, x: number, y: number) {
    const expectedRevision = tables.find((t) => t.id === id)?.revision;
    setTables((cur) => cur.map((t) => (t.id === id ? { ...t, positionX: x, positionY: y } : t)));
    try {
      const { table } = await api.patch<{ table: SeatingTableDTO }>(
        `/api/v1/weddings/${weddingId}/tables/${id}`,
        { positionX: x, positionY: y, expectedRevision }
      );
      // FR-7.7: sync the server's incremented revision back so the *next* drag's expectedRevision
      // is still accurate -- without this, every move after the first would be rejected as stale.
      setTables((cur) => cur.map((t) => (t.id === id ? table : t)));
    } catch (err) {
      // A position conflict is low-stakes (nobody's seating was affected) and dragging is a
      // frequent, low-friction gesture -- silently re-sync to the fresh table instead of
      // interrupting the user with an error for something this minor.
      const fresh = conflictTable(err);
      if (fresh) {
        setTables((cur) => cur.map((t) => (t.id === id ? fresh : t)));
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't save that table's position.");
      }
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
      {!canEdit && (
        <p className="mb-4 rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-600">
          You have view-only access to this wedding's tables — adding, editing, and moving tables
          is turned off.
        </p>
      )}
      {canEdit && (
        <>
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
          <p className="mt-1 text-xs text-neutral-500">
            Just a label on its own — pair it with a criterion below for it to actually affect
            generation.
          </p>
        </div>
        <div>
          <label htmlFor="table-criterion-type" className="mb-1 block text-sm font-medium">
            Purpose criterion (optional)
          </label>
          <select
            id="table-criterion-type"
            className="mb-2 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={criterionType}
            onChange={(e) => {
              const next = e.target.value as TablePurposeCriterionType | "";
              setCriterionType(next);
              setCriterionValue(
                next === "SIDE" ? "BRIDE" : next === "TIER" ? TIER_VALUES[0] : next === "AGE_CATEGORY" ? "CHILD" : ""
              );
            }}
          >
            {CRITERION_TYPES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {criterionType && (
            <select
              id="table-criterion-value"
              aria-label="Purpose criterion value"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
              value={criterionValue}
              onChange={(e) => setCriterionValue(e.target.value)}
            >
              {(criterionType === "SIDE"
                ? SIDE_VALUES
                : criterionType === "TIER"
                  ? TIER_VALUES.map((v) => ({ value: v, label: v.replace("_", " ") }))
                  : AGE_CATEGORY_VALUES.map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() }))
              ).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <p className="mt-1 text-xs text-neutral-500">
            A soft preference (FR-3.7) — favors matching guests but never blocks anyone else, and
            overflow is seated elsewhere rather than failing generation.
          </p>
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
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={singleSideOnly}
            onChange={(e) => setSingleSideOnly(e.target.checked)}
          />
          Single-Side Only (favor seating just one side here, regardless of the wedding&apos;s
          overall Side-Mixing setting)
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

      <details className="mb-6 rounded-lg border border-neutral-200 p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Save as a reusable template
        </summary>
        <p className="mt-2 mb-3 text-sm text-neutral-500">
          Saves this wedding&apos;s current table layout (labels, capacities, shapes, Purpose-table
          criteria) and its Side-Mixing setting as a template you can start a different wedding
          from later. Never includes any guest — a Restricted table&apos;s required-guest list
          doesn&apos;t carry over, since it has no meaning for a different wedding&apos;s guests.
        </p>
        <form onSubmit={onSaveAsTemplate} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="template-name" className="mb-1 block text-xs font-medium">
              Template name
            </label>
            <input
              id="template-name"
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              placeholder="e.g. Standard reception layout"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              required
            />
          </div>
          <button
            type="submit"
            disabled={savingTemplate}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
          >
            {savingTemplate ? "Saving..." : "Save as template"}
          </button>
        </form>
        {savedTemplate && (
          <p className="mt-2 text-sm text-green-700">
            Saved &ldquo;{savedTemplate.name}&rdquo; ({savedTemplate.tableCount} table
            {savedTemplate.tableCount === 1 ? "" : "s"}) — pick it when creating a new wedding from
            your dashboard.
          </p>
        )}
      </details>
        </>
      )}

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
        <FloorPlan
          tables={tables}
          assignedHeadcountByTable={assignedHeadcountByTable}
          onMove={onMove}
          canEdit={canEdit}
        />
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
                    {t.singleSideOnly && (
                      <span className="ml-2 rounded bg-purple-50 px-1.5 py-0.5 text-xs text-purple-700">
                        single-side only
                      </span>
                    )}
                    {t.purposeCriterionType && (
                      <span
                        className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700"
                        title="A soft preference for generation (FR-3.7) -- never blocks anyone else from being seated here."
                      >
                        favors {criterionValueLabel(t.purposeCriterionType, t.purposeCriterionValue, SIDE_VALUES)}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-neutral-500">
                    {assigned}/{t.capacity} seated ({t.capacity - assigned} remaining)
                    {t.purpose ? ` · ${t.purpose}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {canEdit ? (
                    <>
                      <label className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          checked={t.isAccessible}
                          onChange={(e) => onToggleAccessible(t.id, e.target.checked)}
                        />
                        Accessible
                      </label>
                      <label className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          checked={t.singleSideOnly}
                          onChange={(e) => onToggleSingleSideOnly(t.id, e.target.checked)}
                        />
                        Single-side
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
                    </>
                  ) : (
                    t.isAccessible && <span className="text-sm text-neutral-500">Accessible</span>
                  )}
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
  canEdit,
}: {
  tables: SeatingTableDTO[];
  assignedHeadcountByTable: Record<string, number>;
  onMove: (id: string, x: number, y: number) => void;
  canEdit: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>({});

  function positionFor(t: SeatingTableDTO): { x: number; y: number } {
    return localPositions[t.id] ?? { x: t.positionX ?? 40, y: t.positionY ?? 40 };
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>, t: SeatingTableDTO) {
    if (!canEdit) return;
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
        {canEdit
          ? "Drag a table to arrange the room. Position is saved automatically and never affects seating rules or generation."
          : "View-only — dragging tables to rearrange the room is turned off for your access level."}
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
              className={`absolute flex select-none flex-col items-center justify-center border-2 bg-white p-1 text-center text-xs shadow-sm ${
                canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-default"
              } ${SHAPE_STYLE[t.shape]} ${
                over ? "border-red-400" : t.isAccessible ? "border-blue-400" : "border-neutral-300"
              }`}
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
