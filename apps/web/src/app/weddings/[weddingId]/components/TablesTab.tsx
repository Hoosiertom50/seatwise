"use client";

import { useEffect, useRef, useState } from "react";
import { ConfirmDeleteButton } from "@/components/ConfirmDeleteButton";
import { api, ApiError, apiErrorMessage } from "@/lib/api-client";
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
import { compareTableLabels, GUEST_TIER_LABELS, type GuestTier } from "@seatwise/shared";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { useSerialTasks } from "@/lib/serial-tasks";
import { OPEN_EDIT_MESSAGE } from "@/lib/display-format";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

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
  if (type === "TIER") return GUEST_TIER_LABELS[value as GuestTier] ?? value;
  return value.charAt(0) + value.slice(1).toLowerCase();
}

// FR-4.1: shape only ever affects this drawing -- never seating logic.
//
// TS-106: shape drives both the corner radius AND the footprint. Radius alone is not enough --
// on a fixed square box, `rounded-full` renders an oval identically to a round table, and
// `rounded-md` renders a rectangular one identically to a square, so two of the five options were
// indistinguishable and the plan was a less accurate picture of the room than the data allowed.
//
// OVAL uses `rounded-[50%]` rather than `rounded-full`: on a non-square box `rounded-full`
// (9999px) clamps to a stadium/pill, whereas a 50% radius gives a true ellipse.
const SHAPE_STYLE: Record<TableShape, string> = {
  ROUND: "rounded-full",
  OVAL: "rounded-[50%]",
  SQUARE: "rounded-md",
  RECTANGULAR: "rounded-md",
  OTHER: "rounded-md border-dashed",
};

const BOX_SIZE = 96; // px -- the square footprint, and the fallback for an unrecognized shape

/**
 * TS-106: each shape's drawn footprint.
 *
 * ROUND/SQUARE/OTHER stay square; OVAL/RECTANGULAR are wider than they are tall, which is what
 * makes them tell apart from their square-footprint counterparts. Combined with SHAPE_STYLE all
 * five options are now visually distinct:
 *
 *   ROUND        96x96   circle
 *   SQUARE       96x96   rounded square
 *   OTHER        96x96   rounded square, dashed border
 *   OVAL        132x84   ellipse
 *   RECTANGULAR 132x84   rounded rectangle
 *
 * OTHER is deliberately NOT given a distinctive footprint. `SeatingTable.shape` has no companion
 * free-text field (unlike `Vendor.categoryOther`), so the app genuinely cannot know what shape
 * "Other" means -- inventing proportions for it would make the floor plan *less* accurate, which
 * is the opposite of this change's point. The dashed border is the honest signal that the drawing
 * is indicative rather than literal, and the planner carries the real meaning in the table's own
 * label (see e2e/tests/tables.every-shape-and-capacity-saves-without-affecting-seating.spec.ts,
 * which names its Other table "Sweetheart Table").
 */
const SHAPE_SIZE: Record<TableShape, { width: number; height: number }> = {
  ROUND: { width: BOX_SIZE, height: BOX_SIZE },
  SQUARE: { width: BOX_SIZE, height: BOX_SIZE },
  OTHER: { width: BOX_SIZE, height: BOX_SIZE },
  OVAL: { width: 132, height: 84 },
  RECTANGULAR: { width: 132, height: 84 },
};

/** A table's drawn footprint, falling back to the square default if the API ever returns a shape
 * this build does not know about (a newer enum member against an older client). */
function sizeForShape(shape: TableShape): { width: number; height: number } {
  return SHAPE_SIZE[shape] ?? { width: BOX_SIZE, height: BOX_SIZE };
}

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
  // TS-166: a table's quick saves (lock, accessible, single-side, position) run one at a time, each
  // with the table's latest confirmed revision -- ticking two boxes quickly used to send the same
  // revision twice, and the second was refused as "edited elsewhere".
  const queueTableSave = useSerialTasks();
  const tableRevisions = useRef(new Map<string, number>());
  useEffect(() => {
    for (const t of tables) {
      const known = tableRevisions.current.get(t.id);
      if (known === undefined || t.revision > known) tableRevisions.current.set(t.id, t.revision);
    }
  }, [tables]);
  function patchTable<T extends { table: SeatingTableDTO }>(id: string, body: Record<string, unknown>): Promise<T> {
    return queueTableSave(async () => {
      const res = await api.patch<T>(`/api/v1/weddings/${weddingId}/tables/${id}`, {
        ...body,
        expectedRevision: tableRevisions.current.get(id),
      });
      tableRevisions.current.set(id, res.table.revision);
      return res;
    });
  }
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "floorplan">("list");

  const [label, setLabel] = useState("");
  // TS-182: number boxes keep what was typed, so clearing one to type a new number doesn't show 0.
  const [capacity, setCapacity] = useState("8");
  const [purpose, setPurpose] = useState("");
  const [isRestricted, setIsRestricted] = useState(false);
  const [isAccessible, setIsAccessible] = useState(false);
  const [singleSideOnly, setSingleSideOnly] = useState(false);
  const [criterionType, setCriterionType] = useState<TablePurposeCriterionType | "">("");
  const [criterionValue, setCriterionValue] = useState("");
  const [shape, setShape] = useState<TableShape>("ROUND");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TS-124: a table with guests seated at it in the current plan is only removed after the
  // planner confirms, from the server's own count.
  const [confirmRemoval, setConfirmRemoval] = useState<{ id: string; message: string } | null>(null);
  const [tableWarnings, setTableWarnings] = useState<string[]>([]);
  // TS-120: the one table (if any) whose row is open for editing.
  const [editingId, setEditingId] = useState<string | null>(null);
  // TS-175: whether the open edit form has actually been changed -- just opening it isn't unsaved
  // input (it used to bring up "you have unsaved changes" on its own).
  const [editDirty, setEditDirty] = useState(false);
  // TS-191: "Remove anyway" is working (a second press used to send the removal twice).
  const [removingAnyway, setRemovingAnyway] = useState(false);
  // TS-191: closes the open edit and puts focus back on that table's Edit button.
  function closeEdit(id: string | null) {
    setEditingId(null);
    setEditDirty(false);
    if (id) {
      setTimeout(() => {
        const button = document.getElementById(`edit-table-button-${id}`);
        if (button && button.isConnected) button.focus();
      }, 0);
    }
  }
  // TS-191: Edit access taken away while a table's edit was open -- it can't be saved any more, so
  // it closes (and stops counting as unsaved).
  useEffect(() => {
    if (canEdit) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TS-191: closes the edit form when Edit access goes.
    setEditingId(null);
    setEditDirty(false);
    setConfirmRemoval(null);
  }, [canEdit]);

  // FR-4.2: quick-create a standard set of tables in one action.
  const [qcCount, setQcCount] = useState("12");
  const [qcCapacity, setQcCapacity] = useState("8");
  const [qcShape, setQcShape] = useState<TableShape>("ROUND");
  const [qcPrefix, setQcPrefix] = useState("Table");
  const [qcCreating, setQcCreating] = useState(false);

  // TS-19 (FR-14.1/FR-14.2): save this wedding's current table layout + Side-Mixing setting as a
  // reusable template -- see save-as-template's own route comment for why EDIT access is enough.
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [savedTemplate, setSavedTemplate] = useState<SeatingTemplateDTO | null>(null);
  // TS-159: tell the page this tab has input that leaving it would lose.
  // TS-182: only while the forms are there (they're hidden without Edit access).
  useUnsavedChanges("tables", canEdit && !!(label.trim() || purpose.trim() || templateName.trim() || (editingId && editDirty)));

  // TS-91: add a saved template's tables to this existing wedding (additive -- nothing already
  // here changes). The template list loads the first time the section is opened.
  const [myTemplates, setMyTemplates] = useState<SeatingTemplateDTO[] | null>(null);
  // TS-182: the list couldn't be loaded -- it used to say "Loading your templates…" for good.
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [applyTemplateId, setApplyTemplateId] = useState("");
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const [appliedMessage, setAppliedMessage] = useState<string | null>(null);

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
          capacity: Number(capacity),
          purpose: purpose || null,
          isRestricted,
          isAccessible,
          singleSideOnly,
          purposeCriterionType: criterionType || null,
          purposeCriterionValue: criterionType ? criterionValue : null,
          shape,
        }
      );
      // TS-166: built from the list as it is now, so another change made meanwhile isn't lost.
      setTables((cur) => [...cur, table].sort((a, b) => compareTableLabels(a.label, b.label)));
      setLabel("");
      setCapacity("8");
      setPurpose("");
      setIsRestricted(false);
      setIsAccessible(false);
      setSingleSideOnly(false);
      setCriterionType("");
      setCriterionValue("");
      setShape("ROUND");
    } catch (err) {
      setError(apiErrorMessage(err, [], "Couldn't add that table."));
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
        { count: Number(qcCount), capacity: Number(qcCapacity), shape: qcShape, labelPrefix: qcPrefix }
      );
      setTables((cur) => [...cur, ...created].sort((a, b) => compareTableLabels(a.label, b.label)));
    } catch (err) {
      setError(apiErrorMessage(err, [], "Couldn't create those tables."));
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
      // TS-182: "Add tables from a template" shows the new one straight away.
      if (myTemplates !== null || templatesFailed) void loadMyTemplates(true);
    } catch (err) {
      setError(apiErrorMessage(err, [], "Couldn't save that template."));
    } finally {
      setSavingTemplate(false);
    }
  }

  async function loadMyTemplates(force = false) {
    if (myTemplates && !force) return;
    setTemplatesFailed(false);
    try {
      const { templates } = await api.get<{ templates: SeatingTemplateDTO[] }>(`/api/v1/templates`);
      setMyTemplates(templates);
      // Keeps the one already picked, if it's still there.
      setApplyTemplateId((cur) => (templates.some((t) => t.id === cur) ? cur : (templates[0]?.id ?? "")));
    } catch {
      setTemplatesFailed(true);
    }
  }

  async function onApplyTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!applyTemplateId) return;
    setError(null);
    setAppliedMessage(null);
    setApplyingTemplate(true);
    try {
      const res = await api.post<{ addedCount: number; tables: SeatingTableDTO[] }>(
        `/api/v1/weddings/${weddingId}/apply-template`,
        { templateId: applyTemplateId }
      );
      setTables(res.tables);
      const name = myTemplates?.find((t) => t.id === applyTemplateId)?.name ?? "the template";
      setAppliedMessage(
        `Added ${res.addedCount} table${res.addedCount === 1 ? "" : "s"} from “${name}”. Tables already here weren't changed.`
      );
    } catch (err) {
      setError(apiErrorMessage(err, [], "Couldn't add tables from that template."));
    } finally {
      setApplyingTemplate(false);
    }
  }

  async function onRemove(id: string, confirmed = false) {
    setError(null);
    if (confirmed) setRemovingAnyway(true);
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/tables/${id}${confirmed ? "?confirm=true" : ""}`);
      setConfirmRemoval(null);
      setTables((current) => current.filter((t) => t.id !== id));
      // TS-191: a removed table's open edit goes with it -- it used to keep counting as unsaved,
      // with no form left on screen to save or cancel. (The form also reports "not changed" as it
      // closes; see TableEditForm.)
      setEditingId((cur) => (cur === id ? null : cur));
    } catch (err) {
      // TS-124: guests are seated here -- ask rather than silently unseat them.
      if (err instanceof ApiError && err.status === 409 && err.data?.needsConfirmation) {
        setConfirmRemoval({ id, message: err.message });
        return;
      }
      setConfirmRemoval(null);
      setError(apiErrorMessage(err, [], "Couldn't remove that table."));
    } finally {
      if (confirmed) setRemovingAnyway(false);
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
    setTables((cur) => cur.map((t) => (t.id === id ? { ...t, isLocked } : t)));
    try {
      const { table } = await patchTable<{ table: SeatingTableDTO }>(id, { isLocked });
      setTables((cur) => cur.map((t) => (t.id === id ? table : t)));
    } catch (err) {
      const fresh = conflictTable(err);
      if (fresh) {
        setTables((cur) => cur.map((t) => (t.id === id ? fresh : t)));
        setError(`"${fresh.label}" changed since you loaded it (maybe in another tab, or by someone else) — showing the latest. Try again if you still want to make this change.`);
      } else {
        // TS-151: put back only this table -- other rows may have changed meanwhile.
        setTables((cur) => cur.map((t) => (t.id === id ? (prev.find((p) => p.id === id) ?? t) : t)));
        setError(apiErrorMessage(err, [], "Couldn't update that table's lock."));
      }
    }
  }

  // FR-4.6: unmarking (or re-marking) Accessible re-checks anyone currently seated here who
  // requires one -- the server flags/clears Needs Reassignment and keeps completeness in sync;
  // this just surfaces whatever warning message came back.
  async function onToggleAccessible(id: string, next: boolean) {
    const prev = tables;
    setTables((cur) => cur.map((t) => (t.id === id ? { ...t, isAccessible: next } : t)));
    try {
      const res = await patchTable<{ table: SeatingTableDTO; warnings: string[] }>(id, { isAccessible: next });
      setTables((cur) => cur.map((t) => (t.id === id ? res.table : t)));
      setTableWarnings(res.warnings ?? []);
    } catch (err) {
      const fresh = conflictTable(err);
      if (fresh) {
        setTables((cur) => cur.map((t) => (t.id === id ? fresh : t)));
        setError(`"${fresh.label}" changed since you loaded it (maybe in another tab, or by someone else) — showing the latest. Try again if you still want to make this change.`);
      } else {
        // TS-151: put back only this table -- other rows may have changed meanwhile.
        setTables((cur) => cur.map((t) => (t.id === id ? (prev.find((p) => p.id === id) ?? t) : t)));
        setError(apiErrorMessage(err, [], "Couldn't update that table's accessible flag."));
      }
    }
  }

  // FR-3.4: a plain boolean toggle, same pattern as isLocked -- unlike isAccessible it never has
  // a hard-rule reassignment side effect, so there's nothing else to surface here.
  async function onToggleSingleSideOnly(id: string, next: boolean) {
    const prev = tables;
    setTables((cur) => cur.map((t) => (t.id === id ? { ...t, singleSideOnly: next } : t)));
    try {
      const { table } = await patchTable<{ table: SeatingTableDTO }>(id, { singleSideOnly: next });
      setTables((cur) => cur.map((t) => (t.id === id ? table : t)));
    } catch (err) {
      const fresh = conflictTable(err);
      if (fresh) {
        setTables((cur) => cur.map((t) => (t.id === id ? fresh : t)));
        setError(`"${fresh.label}" changed since you loaded it (maybe in another tab, or by someone else) — showing the latest. Try again if you still want to make this change.`);
      } else {
        // TS-151: put back only this table -- other rows may have changed meanwhile.
        setTables((cur) => cur.map((t) => (t.id === id ? (prev.find((p) => p.id === id) ?? t) : t)));
        setError(apiErrorMessage(err, [], "Couldn't update that table's Single-Side-Only setting."));
      }
    }
  }

  async function onMove(id: string, x: number, y: number) {
    const before = tables.find((t) => t.id === id);
    setTables((cur) => cur.map((t) => (t.id === id ? { ...t, positionX: x, positionY: y } : t)));
    try {
      const { table } = await patchTable<{ table: SeatingTableDTO }>(id, { positionX: x, positionY: y });
      // FR-7.7: sync the server's incremented revision back so the *next* drag's expectedRevision
      // is still accurate -- without this, every move after the first would be rejected as stale.
      setTables((cur) => cur.map((t) => (t.id === id ? table : t)));
    } catch (err) {
      // TS-92: a position conflict used to re-sync silently, as too minor to mention -- but then the
      // table jumps somewhere the planner didn't put it with no explanation, and they can't tell
      // their move didn't save. Re-sync to the other person's position *and* say so.
      const fresh = conflictTable(err);
      if (fresh) {
        setTables((cur) => cur.map((t) => (t.id === id ? fresh : t)));
        setError(
          `"${fresh.label}" was moved since you loaded it (maybe in another tab, or by someone else) — showing where it is now. Drag it again if you still want it moved.`
        );
      } else {
        // TS-110: put the table back where the server still has it -- leaving it at the dropped
        // position would show a layout that was never saved.
        if (before) setTables((cur) => cur.map((t) => (t.id === id ? before : t)));
        setError(apiErrorMessage(err, [], "Couldn't save that table's position."));
      }
    }
  }

  if (loading) return <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading tables...</p>;

  const totalCapacity = tables.reduce((sum, t) => sum + t.capacity, 0);
  const attendingHeadcount = guests
    .filter((g) => g.dayOfAttendance === "ATTENDING")
    .reduce((sum, g) => sum + g.headcount, 0);
  const totalAssigned = Object.values(assignedHeadcountByTable).reduce((sum, n) => sum + n, 0);
  const shortfall = attendingHeadcount - totalCapacity;

  return (
    <div>
      {!canEdit && (
        <p className="mb-4 rounded-md bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300">
          You have view-only access to this wedding&apos;s tables — adding, editing, and moving tables
          is turned off.
        </p>
      )}
      {canEdit && (
        <>
      <h2 className="mb-3 text-lg font-medium">Add a table</h2>
      <form
        onSubmit={onAdd}
        className="mb-6 grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 sm:grid-cols-2"
      >
        <div>
          <label htmlFor="table-name" className="mb-1 block text-sm font-medium">
            Table name
          </label>
          <input
            maxLength={FIELD_LIMITS.tableLabel}
            id="table-name"
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
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
            inputMode="numeric"
            id="table-capacity"
            type="number"
            min={1}
            max={50}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="table-shape" className="mb-1 block text-sm font-medium">
            Shape
          </label>
          <select
            id="table-shape"
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
            value={shape}
            onChange={(e) => setShape(e.target.value as TableShape)}
          >
            {SHAPES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Affects only the floor-plan drawing below.</p>
        </div>
        <div>
          <label htmlFor="table-purpose" className="mb-1 block text-sm font-medium">
            Purpose (optional)
          </label>
          <input
            maxLength={FIELD_LIMITS.tablePurpose}
            id="table-purpose"
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
            placeholder="e.g. Kids table, Head table"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
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
            className="mb-2 w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
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
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={criterionValue}
              onChange={(e) => setCriterionValue(e.target.value)}
            >
              {(criterionType === "SIDE"
                ? SIDE_VALUES
                : criterionType === "TIER"
                  ? TIER_VALUES.map((v) => ({ value: v, label: GUEST_TIER_LABELS[v] }))
                  : AGE_CATEGORY_VALUES.map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() }))
              ).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            A soft preference — favors matching guests but never blocks anyone else, and
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
          className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50 sm:col-span-2"
        >
          {adding ? "Adding..." : "Add table"}
        </button>
      </form>

      <details className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Quick-create a standard set of tables
        </summary>
        <form onSubmit={onQuickCreate} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor="qc-count" className="mb-1 block text-xs font-medium">
              How many
            </label>
            <input
              inputMode="numeric"
              id="qc-count"
              type="number"
              min={1}
              max={100}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
              value={qcCount}
              onChange={(e) => setQcCount(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="qc-capacity" className="mb-1 block text-xs font-medium">
              Seats each
            </label>
            <input
              inputMode="numeric"
              id="qc-capacity"
              type="number"
              min={1}
              max={50}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
              value={qcCapacity}
              onChange={(e) => setQcCapacity(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="qc-shape" className="mb-1 block text-xs font-medium">
              Shape
            </label>
            <select
              id="qc-shape"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
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
              maxLength={FIELD_LIMITS.tableLabelPrefix}
              id="qc-prefix"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
              value={qcPrefix}
              onChange={(e) => setQcPrefix(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={qcCreating}
            className="col-span-2 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 sm:col-span-4"
          >
            {qcCreating
              ? "Creating..."
              : `Create ${qcCount} ${qcShape.toLowerCase()} table(s) of ${qcCapacity}`}
          </button>
        </form>
      </details>

      <details className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Save as a reusable template
        </summary>
        <p className="mt-2 mb-3 text-sm text-neutral-500 dark:text-neutral-400">
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
              maxLength={FIELD_LIMITS.templateName}
              id="template-name"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
              placeholder="e.g. Standard reception layout"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              required
            />
          </div>
          <button
            type="submit"
            disabled={savingTemplate}
            className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            {savingTemplate ? "Saving..." : "Save as template"}
          </button>
        </form>
        {savedTemplate && (
          <p role="status" className="mt-2 text-sm text-green-700 dark:text-green-400">
            Saved &ldquo;{savedTemplate.name}&rdquo; ({savedTemplate.tableCount} table
            {savedTemplate.tableCount === 1 ? "" : "s"}) — pick it when creating a new wedding from
            your dashboard.
          </p>
        )}
      </details>

      {/* TS-91: the other half of reusable layouts -- until now a template could only be picked
          when creating a wedding. */}
      <details
        className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4"
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) void loadMyTemplates();
        }}
      >
        <summary className="cursor-pointer text-sm font-medium">Add tables from a template</summary>
        <p className="mt-2 mb-3 text-sm text-neutral-500 dark:text-neutral-400">
          Adds a saved template&apos;s tables (with their positions, shapes and settings) to this
          wedding. Tables already here stay exactly as they are; a name that&apos;s already taken
          gets a number added.
        </p>
        {templatesFailed ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            Couldn&apos;t load your templates.{" "}
            <button type="button" onClick={() => void loadMyTemplates(true)} className="underline hover:no-underline">
              Try again
            </button>
          </p>
        ) : myTemplates === null ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading your templates…</p>
        ) : myTemplates.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            You haven&apos;t saved any templates yet — use &ldquo;Save as a reusable template&rdquo; above on a
            wedding whose layout you want to reuse.
          </p>
        ) : (
          <form onSubmit={onApplyTemplate} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label htmlFor="apply-template" className="mb-1 block text-xs font-medium">
                Template
              </label>
              <select
                id="apply-template"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
                value={applyTemplateId}
                onChange={(e) => setApplyTemplateId(e.target.value)}
              >
                {myTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.tableCount} table{t.tableCount === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={applyingTemplate}
              className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
            >
              {applyingTemplate ? "Adding..." : "Add these tables"}
            </button>
          </form>
        )}
        {appliedMessage && <p role="status" className="mt-2 text-sm text-green-700 dark:text-green-400">{appliedMessage}</p>}
      </details>
        </>
      )}

      {error && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {tableWarnings.length > 0 && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950 p-3 text-sm text-amber-800 dark:text-amber-300">
          {tableWarnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      {/* FR-4.5: capacity overview -- Attending count, assigned count, remaining capacity, and
          the exact shortfall when guests exceed capacity. Not Attending guests are excluded
          (attendingHeadcount already filters to dayOfAttendance === "ATTENDING"). */}
      <div className="mb-6 grid grid-cols-2 gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 text-sm sm:grid-cols-4">
        <div>
          <p className="text-neutral-500 dark:text-neutral-400">Attending</p>
          <p className="text-lg font-medium">{attendingHeadcount}</p>
        </div>
        <div>
          <p className="text-neutral-500 dark:text-neutral-400">Total capacity</p>
          <p className="text-lg font-medium">{totalCapacity}</p>
        </div>
        <div>
          <p className="text-neutral-500 dark:text-neutral-400">Assigned</p>
          <p className="text-lg font-medium">{totalAssigned}</p>
        </div>
        <div>
          {/* TS-177: seats left after everyone attending, not after who's seated (each table row's "remaining"). */}
          <p className="text-neutral-500 dark:text-neutral-400">Spare seats (after everyone attending)</p>
          <p className={`text-lg font-medium ${shortfall > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
            {totalCapacity - attendingHeadcount}
          </p>
        </div>
        {shortfall > 0 && (
          <p className="col-span-2 text-red-600 dark:text-red-400 sm:col-span-4">
            Short {shortfall} seat(s) for everyone attending — add capacity or generation will
            report the shortfall rather than overfilling a table.
          </p>
        )}
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-medium">
          Tables ({tables.length}, {totalCapacity} seats)
        </h2>
        <div className="flex gap-1 rounded-md border border-neutral-300 dark:border-neutral-600 p-0.5 text-sm">
          <button
            onClick={() => setView("list")}
            aria-pressed={view === "list"}
            className={`rounded px-2 py-1 ${view === "list" ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"}`}
          >
            List
          </button>
          <button
            onClick={() => setView("floorplan")}
            aria-pressed={view === "floorplan"}
            className={`rounded px-2 py-1 ${view === "floorplan" ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"}`}
          >
            Floor plan
          </button>
        </div>
      </div>

      {tables.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {/* TS-96: point a new planner at the one-step way to set up a whole room. */}
          No tables yet — add one above, or open “Quick-create a standard set of tables” to make them all in one step.
        </p>
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
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3"
              >
                {/* TS-191: a long unbroken name wraps instead of running off a phone screen. */}
                <div className="min-w-0">
                  <p className="break-words font-medium [overflow-wrap:anywhere]">
                    {t.label}
                    <span className="ml-2 rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-600 dark:text-neutral-300">
                      {t.shape.charAt(0) + t.shape.slice(1).toLowerCase()}
                    </span>
                    {t.isRestricted && (
                      <span className="ml-2 rounded bg-amber-50 dark:bg-amber-950 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                        restricted
                      </span>
                    )}
                    {t.isAccessible && (
                      <span className="ml-2 rounded bg-blue-50 dark:bg-blue-950 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-400">
                        accessible
                      </span>
                    )}
                    {t.isLocked && (
                      <span
                        className="ml-2 rounded bg-neutral-800 dark:bg-neutral-700 px-1.5 py-0.5 text-xs text-white"
                        title="Locked: new plans keep the people already here and seat nobody new here."
                      >
                        locked
                      </span>
                    )}
                    {t.singleSideOnly && (
                      <span className="ml-2 rounded bg-purple-50 dark:bg-purple-950 px-1.5 py-0.5 text-xs text-purple-700 dark:text-purple-300">
                        single-side only
                      </span>
                    )}
                    {t.purposeCriterionType && (
                      <span
                        className="ml-2 rounded bg-emerald-50 dark:bg-emerald-950 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
                        title="A soft preference for generation — never blocks anyone else from being seated here."
                      >
                        favors {criterionValueLabel(t.purposeCriterionType, t.purposeCriterionValue, SIDE_VALUES)}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">
                    {assigned}/{t.capacity} seated ({t.capacity - assigned} remaining)
                    {t.purpose ? ` · ${t.purpose}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
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
                        title="Locked: new plans keep the people already here and seat nobody new here."
                        className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                      >
                        {t.isLocked ? "Unlock" : "Lock"}
                      </button>
                      <button
                        onClick={() => {
                          // TS-182: opening another table used to throw away a changed open edit.
                          if (editingId && editingId !== t.id && editDirty) {
                            setError(OPEN_EDIT_MESSAGE);
                            return;
                          }
                          setError(null);
                          setEditingId(editingId === t.id ? null : t.id);
                          setEditDirty(false);
                        }}
                        id={`edit-table-button-${t.id}`}
                        aria-label={`Edit ${t.label}`}
                        aria-expanded={editingId === t.id}
                        className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                      >
                        Edit
                      </button>
                      {/* TS-136: always asks first. If guests are seated here, the server then asks
                          again with how many (TS-124) before anyone is unseated. */}
                      <ConfirmDeleteButton
                        ariaLabel={`Remove ${t.label}`}
                        question={`Remove the table "${t.label}"? Anyone seated at it, in the current plan or in saved past versions, loses that seat. This can't be undone.`}
                        confirmLabel="Yes, remove table"
                        onConfirm={() => onRemove(t.id)}
                      />
                    </>
                  ) : (
                    t.isAccessible && <span className="text-sm text-neutral-500 dark:text-neutral-400">Accessible</span>
                  )}
                </div>
                {editingId === t.id && (
                  <TableEditForm
                    table={t}
                    save={(body) => patchTable<{ table: SeatingTableDTO; warnings?: string[] }>(t.id, body)}
                    onDirtyChange={setEditDirty}
                    guests={guests}
                    sideValues={SIDE_VALUES}
                    onSaved={(saved, warnings) => {
                      setTables((current) => current.map((x) => (x.id === saved.id ? saved : x)));
                      setTableWarnings(warnings);
                      // TS-191: also clears "changed" and puts focus back on Edit.
                      closeEdit(t.id);
                    }}
                    onConflict={(fresh, message) => {
                      setTables((current) => current.map((x) => (x.id === fresh.id ? fresh : x)));
                      closeEdit(t.id);
                      setError(
                        message ??
                          `"${fresh.label}" changed since you loaded it (maybe in another tab, or by someone else) — showing the latest. Open Edit again to make your change.`
                      );
                    }}
                    onCancel={() => closeEdit(t.id)}
                  />
                )}
                {confirmRemoval?.id === t.id && (
                  <div
                    role="alert"
                    className="mt-3 flex w-full flex-wrap items-center gap-3 rounded-md bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
                  >
                    <span className="flex-1">{confirmRemoval.message}</span>
                    <button
                      onClick={() => onRemove(t.id, true)}
                      disabled={removingAnyway}
                      className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
                    >
                      {removingAnyway ? "Removing…" : "Remove anyway"}
                    </button>
                    <button
                      onClick={() => setConfirmRemoval(null)}
                      disabled={removingAnyway}
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                    >
                      Keep table
                    </button>
                  </div>
                )}
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
  onMove: (id: string, x: number, y: number) => Promise<void>;
  canEdit: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // TS-106: clamping has to know the dragged table's own footprint, not a single constant, now
  // that shapes differ in size -- otherwise a wide table clamps as if it were square and its right
  // edge runs past the canvas. Captured on pointer-down so the move handler stays cheap.
  const dragSize = useRef<{ width: number; height: number }>({ width: BOX_SIZE, height: BOX_SIZE });
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>({});
  // TS-121: keyboard moves. Each arrow press moves the table on screen at once; the save waits
  // until the planner pauses (or tabs away), so a run of presses is one save -- one revision --
  // rather than several racing each other into a conflict.
  // The pending position lives in the ref itself: the delayed save runs from an earlier render's
  // closure, so it must not read `localPositions` (which would be one press behind).
  const keyboardSave = useRef<{ id: string; pos: { x: number; y: number }; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function positionFor(t: SeatingTableDTO): { x: number; y: number } {
    return localPositions[t.id] ?? { x: t.positionX ?? 40, y: t.positionY ?? 40 };
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>, t: SeatingTableDTO) {
    if (!canEdit) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    dragId.current = t.id;
    dragSize.current = sizeForShape(t.shape);
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragId.current || !containerRef.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    let x = e.clientX - containerRect.left - dragOffset.current.x;
    let y = e.clientY - containerRect.top - dragOffset.current.y;
    x = Math.max(0, Math.min(x, containerRect.width - dragSize.current.width));
    y = Math.max(0, Math.min(y, containerRect.height - dragSize.current.height));
    // (containerRect is the whole canvas, not the visible part -- see the canvas below.)
    setLocalPositions((prev) => ({ ...prev, [dragId.current!]: { x, y } }));
  }

  async function onPointerUp() {
    if (!dragId.current) return;
    const id = dragId.current;
    const pos = localPositions[id];
    dragId.current = null;
    if (!pos) return;
    await onMove(id, Math.round(pos.x), Math.round(pos.y));
    // TS-110: the drag-time override has done its job once the save settles. Dropping it means the
    // table renders from `tables` again -- the saved position on success, the reverted one on
    // failure, or the other collaborator's on a 409 -- instead of sticking wherever it was dropped.
    // Left alone if the same table is already being dragged again, so a fast re-grab doesn't jump.
    if (dragId.current === id) return;
    setLocalPositions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // TS-90: the browser can abandon a touch drag (a system gesture, an incoming call, the finger
  // leaving the screen edge). Nothing was saved, so just put the table back where it was.
  function onPointerCancel() {
    const id = dragId.current;
    if (!id) return;
    dragId.current = null;
    setLocalPositions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function flushKeyboardMove() {
    const pending = keyboardSave.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    keyboardSave.current = null;
    await onMove(pending.id, Math.round(pending.pos.x), Math.round(pending.pos.y));
    // A newer run of presses on the same table owns the override now -- leave it be.
    // (Re-read through a widened type: TypeScript narrows it to null above, but presses during
    // the await can set it again.)
    const now = keyboardSave.current as { id: string } | null;
    if (now?.id === pending.id) return;
    setLocalPositions((prev) => {
      const next = { ...prev };
      delete next[pending.id];
      return next;
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>, t: SeatingTableDTO) {
    if (!canEdit || !containerRef.current) return;
    const step = e.shiftKey ? 50 : 10;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    const size = sizeForShape(t.shape);
    // TS-175: kept within the canvas, not the visible part of it -- on a phone a table beyond the
    // screen's width used to jump back into view on the first arrow press.
    const bounds = containerRef.current.getBoundingClientRect();
    const from = positionFor(t);
    const to = {
      x: Math.max(0, Math.min(from.x + d[0], bounds.width - size.width)),
      y: Math.max(0, Math.min(from.y + d[1], bounds.height - size.height)),
    };
    setLocalPositions((prev) => ({ ...prev, [t.id]: to }));
    setAnnouncement(`${t.label} moved to ${Math.round(to.x)}, ${Math.round(to.y)}.`);
    if (keyboardSave.current && keyboardSave.current.id !== t.id) void flushKeyboardMove();
    if (keyboardSave.current) clearTimeout(keyboardSave.current.timer);
    keyboardSave.current = { id: t.id, pos: to, timer: setTimeout(() => void flushKeyboardMove(), 500) };
  }

  const width = Math.max(760, ...tables.map((t) => positionFor(t).x + sizeForShape(t.shape).width + 40));
  const height = Math.max(520, ...tables.map((t) => positionFor(t).y + sizeForShape(t.shape).height + 40));

  return (
    <div>
      <p className="mb-2 text-sm text-neutral-500 dark:text-neutral-400">
        {canEdit
          ? "Drag a table to arrange the room, or select it with Tab and move it with the arrow keys (Shift for bigger steps). Position is saved automatically and never affects seating rules or generation."
          : "View-only — dragging tables to rearrange the room is turned off for your access level."}
      </p>
      {/* TS-175: the room scrolls inside its box (as on the Plan tab) instead of being cut off at
          the screen's edge, so on a phone every table can still be reached. */}
      <div
        style={{ width: "100%", maxWidth: width }}
        className="overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900"
      >
      <div
        ref={containerRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{ width, height }}
        className="relative"
      >
        {tables.map((t) => {
          const pos = positionFor(t);
          const assigned = assignedHeadcountByTable[t.id] ?? 0;
          const over = assigned > t.capacity;
          return (
            <div
              key={t.id}
              onPointerDown={(e) => onPointerDown(e, t)}
              // TS-121: every table can be reached with Tab and, for editors, moved with the arrow keys.
              tabIndex={canEdit ? 0 : undefined}
              role={canEdit ? "button" : "img"}
              aria-roledescription={canEdit ? "movable table" : undefined}
              aria-label={`${t.label}, ${t.capacity} seats, at ${Math.round(pos.x)}, ${Math.round(pos.y)}${canEdit ? ". Use the arrow keys to move it." : ""}`}
              onKeyDown={(e) => onKeyDown(e, t)}
              onBlur={() => {
                if (keyboardSave.current?.id === t.id) void flushKeyboardMove();
              }}
              style={{ left: pos.x, top: pos.y, ...sizeForShape(t.shape) }}
              className={`absolute flex select-none flex-col items-center justify-center border-2 bg-white dark:bg-neutral-900 p-1 text-center text-xs shadow-sm outline-none focus-visible:ring-4 focus-visible:ring-blue-500 ${
                // TS-90: touch-none so a finger drags the table instead of scrolling the page
                // (the browser would otherwise claim the gesture and cancel the pointer).
                canEdit ? "cursor-grab touch-none active:cursor-grabbing" : "cursor-default"
              } ${SHAPE_STYLE[t.shape]} ${
                over ? "border-red-400 dark:border-red-500" : t.isAccessible ? "border-blue-400 dark:border-blue-500" : "border-neutral-300 dark:border-neutral-600"
              }`}
              title={`${t.label} — ${t.capacity} seats${t.purpose ? ` (${t.purpose})` : ""}`}
            >
              <span className="line-clamp-2 font-medium leading-tight">{t.label}</span>
              <span className="text-neutral-500 dark:text-neutral-400">
                {assigned}/{t.capacity}
              </span>
              {t.isRestricted && <span className="text-[10px] text-amber-700 dark:text-amber-400">restricted</span>}
            </div>
          );
        })}
      </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

// TS-120: edit a table after creating it, in place in its row -- name, seats, shape, purpose and
// the soft "favors" criterion, and whether it's Restricted to a chosen list of guests. Saves
// through the same revision check as every other table edit (a stale save is refused with a
// visible message, TS-92), and anything that makes current seating invalid -- fewer seats than
// are taken, a guest no longer on a restricted list -- comes back as a warning with those guests
// flagged Needs Reassignment. Nobody is unseated by an edit.
function TableEditForm({
  table,
  save,
  onDirtyChange,
  guests,
  sideValues,
  onSaved,
  onConflict,
  onCancel,
}: {
  table: SeatingTableDTO;
  /** TS-175: saves through the tab's table queue, so it can't race the row's quick saves. */
  save: (body: Record<string, unknown>) => Promise<{ table: SeatingTableDTO; warnings?: string[] }>;
  onDirtyChange: (dirty: boolean) => void;
  guests: GuestDTO[];
  sideValues: { value: string; label: string }[];
  onSaved: (table: SeatingTableDTO, warnings: string[]) => void;
  // A 409 (someone else's edit landed first) or a 422 partial save (the table saved, its guest
  // list didn't): either way the row shows the table as it now is, with the server's message.
  onConflict: (fresh: SeatingTableDTO, message?: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(table.label);
  const [capacity, setCapacity] = useState(String(table.capacity));
  const [shape, setShape] = useState<TableShape>(table.shape);
  const [purpose, setPurpose] = useState(table.purpose ?? "");
  const [criterionType, setCriterionType] = useState<TablePurposeCriterionType | "">(table.purposeCriterionType ?? "");
  const [criterionValue, setCriterionValue] = useState(table.purposeCriterionValue ?? "");
  const [isRestricted, setIsRestricted] = useState(table.isRestricted);
  const [requiredGuestIds, setRequiredGuestIds] = useState<string[]>(table.requiredGuestIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idBase = `edit-table-${table.id}`;
  const listDiffers =
    requiredGuestIds.length !== table.requiredGuestIds.length ||
    requiredGuestIds.some((id) => !table.requiredGuestIds.includes(id));
  const dirty =
    label !== table.label ||
    capacity !== String(table.capacity) ||
    shape !== table.shape ||
    purpose !== (table.purpose ?? "") ||
    criterionType !== (table.purposeCriterionType ?? "") ||
    criterionValue !== (table.purposeCriterionValue ?? "") ||
    isRestricted !== table.isRestricted ||
    listDiffers;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  // TS-191: however the form closes (saved, cancelled, its table removed, Edit access gone), what
  // was in it no longer counts as unsaved.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  // TS-191: opening the form puts focus in its first box.
  useEffect(() => {
    document.getElementById(`${idBase}-label`)?.focus();
  }, [idBase]);

  const criterionOptions =
    criterionType === "SIDE"
      ? sideValues
      : criterionType === "TIER"
        ? TIER_VALUES.map((v) => ({ value: v, label: GUEST_TIER_LABELS[v] }))
        : AGE_CATEGORY_VALUES.map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() }));

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const listChanged = isRestricted && listDiffers;
      const { table: saved, warnings } = await save(
        {
          label: label.trim(),
          capacity: Number(capacity),
          shape,
          purpose: purpose.trim() || null,
          purposeCriterionType: criterionType || null,
          purposeCriterionValue: criterionType ? criterionValue || criterionOptions[0]?.value || null : null,
          isRestricted,
          ...(listChanged ? { requiredGuestIds } : {}),
        }
      );
      const allWarnings = warnings ?? [];
      onSaved(saved, allWarnings);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 422) && err.data?.table) {
        onConflict(err.data.table as SeatingTableDTO, err.status === 422 ? err.message : undefined);
        return;
      }
      setError(apiErrorMessage(err, [], "Couldn't save that table."));
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm";
  return (
    <form
      onSubmit={onSave}
      aria-label={`Edit ${table.label}`}
      className="mt-3 grid w-full grid-cols-1 gap-3 rounded-md border border-neutral-200 dark:border-neutral-700 p-3 sm:grid-cols-2"
    >
      <div>
        <label htmlFor={`${idBase}-label`} className="mb-1 block text-sm font-medium">Table name</label>
        <input id={`${idBase}-label`} className={field} value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={FIELD_LIMITS.tableLabel} />
      </div>
      <div>
        <label htmlFor={`${idBase}-capacity`} className="mb-1 block text-sm font-medium">Seats</label>
        <input
          inputMode="numeric"
          id={`${idBase}-capacity`}
          type="number"
          min={1}
          max={50}
          className={field}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor={`${idBase}-shape`} className="mb-1 block text-sm font-medium">Shape</label>
        <select id={`${idBase}-shape`} className={field} value={shape} onChange={(e) => setShape(e.target.value as TableShape)}>
          {SHAPES.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idBase}-purpose`} className="mb-1 block text-sm font-medium">Purpose (optional)</label>
        <input id={`${idBase}-purpose`} className={field} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={FIELD_LIMITS.tablePurpose} />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor={`${idBase}-criterion`} className="mb-1 block text-sm font-medium">Favors</label>
        <div className="flex flex-wrap gap-2">
          <select
            id={`${idBase}-criterion`}
            className={field}
            value={criterionType}
            onChange={(e) => {
              setCriterionType(e.target.value as TablePurposeCriterionType | "");
              setCriterionValue("");
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
              aria-label="Favors which"
              className={field}
              value={criterionValue || criterionOptions[0]?.value}
              onChange={(e) => setCriterionValue(e.target.value)}
            >
              {criterionOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="sm:col-span-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isRestricted} onChange={(e) => setIsRestricted(e.target.checked)} />
          Restricted — only the guests chosen below sit here
        </label>
        {isRestricted && (
          <div
            role="group"
            aria-label={`Required guests for ${table.label}`}
            className="mt-2 max-h-48 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700 p-2"
          >
            {guests.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">No guests yet.</p>
            ) : (
              guests.map((g) => (
                <label key={g.id} className="flex items-center gap-2 py-0.5 text-sm">
                  <input
                    type="checkbox"
                    checked={requiredGuestIds.includes(g.id)}
                    onChange={(e) =>
                      setRequiredGuestIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((id) => id !== g.id)))
                    }
                  />
                  {g.firstName} {g.lastName}
                </label>
              ))
            )}
          </div>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400 sm:col-span-2">{error}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
