"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { useSerialTasks } from "@/lib/serial-tasks";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { RULE_WEIGHT_CONFIG, compareTableLabels } from "@seatwise/shared";
import type {
  GuestDTO,
  PlanVersionComparisonDTO,
  PlanVersionDTO,
  PlanVersionDetailDTO,
  PlanVersionScoreReportDTO,
  PlanVersionStatusValue,
  RestorePreviewDTO,
  SeatingTableDTO,
} from "@seatwise/shared";

const COMPARISON_STATUS_LABEL: Record<PlanVersionComparisonDTO["guests"][number]["status"], string> = {
  unchanged: "Unchanged",
  moved: "Moved",
  added: "Added",
  removed: "Removed",
};

const COMPARISON_STATUS_CLASS: Record<PlanVersionComparisonDTO["guests"][number]["status"], string> = {
  unchanged: "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300",
  moved: "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-400",
  added: "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400",
  removed: "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400",
};

function versionOptionLabel(v: PlanVersionDTO): string {
  // FR-5.6: a Comparison Draft can be *newer* than the Current version (list order alone no
  // longer implies which one is current), so the picker always says explicitly which is which.
  return `v${v.versionNumber}${v.label ? ` — ${v.label}` : ""}${v.isCurrent ? " (current)" : ""} (${new Date(v.createdAt).toLocaleDateString()})`;
}

// FR-7.1: the floor-plan boxes reuse each table's saved (positionX, positionY) from the Tables
// tab's own floor plan (FR-4.3) so both views agree on where a table sits in the room -- only its
// footprint differs here, since this view also needs room to list the guests seated at it.
const PLAN_BOX_WIDTH = 224;
// A fixed (not minimum) height -- a table box's guest list scrolls internally within this
// footprint rather than growing the box itself, so a full table never grows tall enough to
// overlap the row of boxes below it. Sized for the label line plus the guest list's own
// max-h-36 (144px) scroll region, with a little padding room.
const PLAN_BOX_HEIGHT = 200;

// What a single onMoveGuest call resolved to -- empty means a clean move with nothing to report.
interface MoveGuestResult {
  error?: string;
  warnings?: string[];
}

// FR-7.5: one manual-move action, as recorded for undo/redo. `toTableId` is the table the guest's
// own unit ended up at; `priorTableId` is where *this specific guest* was seated before (null if
// they were unassigned). Undoing/redoing replays a single move-or-unassign call for `guestId` --
// since MUST_SIT_TOGETHER membership is still live and unchanged, the backend sweeps the same
// whole unit along again, exactly mirroring how the original action worked.
interface UndoEntry {
  guestId: string;
  priorTableId: string | null;
  toTableId: string;
  description: string;
}

const STATUS_LABEL: Record<PlanVersionStatusValue, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In review",
  APPROVED: "Approved",
};

const STATUS_BADGE_CLASS: Record<PlanVersionStatusValue, string> = {
  DRAFT: "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300",
  IN_REVIEW: "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-400",
  APPROVED: "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400",
};

export function PlanTab({
  weddingId,
  guests,
  canEdit,
  canApprove,
}: {
  weddingId: string;
  guests: GuestDTO[];
  canEdit: boolean;
  /** TS-151: may approve this plan (owner, or a Couple member with Comment/Edit access). */
  canApprove: boolean;
}) {
  const [versions, setVersions] = useState<PlanVersionDTO[]>([]);
  const [detail, setDetail] = useState<PlanVersionDetailDTO | null>(null);
  const [tables, setTables] = useState<SeatingTableDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  // FR-5.6: the planner's upfront choice for the *next* generation run -- true (the default)
  // makes it the new Current version, replacing whichever was Current before; false saves it
  // alongside as a non-replacing Comparison Draft instead.
  const [saveAsDraft, setSaveAsDraft] = useState(false);
  // FR-5.3: the just-generated plan's soft-preference report -- shown only right after this
  // generation run, same lifecycle as moveWarnings below (not persisted for a later reload).
  const [scoreReport, setScoreReport] = useState<PlanVersionScoreReportDTO | null>(null);
  const [showScoreDetail, setShowScoreDetail] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  // TS-170: every guest with a move queued or on its way (one value used to stand for all of
  // them, so a row whose move was still queued looked idle again).
  const [movingIds, setMovingIds] = useState<ReadonlySet<string>>(new Set());
  const markMoving = (id: string, moving: boolean) =>
    setMovingIds((cur) => {
      const next = new Set(cur);
      if (moving) next.add(id);
      else next.delete(id);
      return next;
    });
  // TS-166: moves run one at a time, each against the plan as the previous one left it (see
  // serial-tasks.ts); detailRef is that latest copy, updated as soon as a move comes back.
  const queueMove = useSerialTasks();
  const detailRef = useRef<PlanVersionDetailDTO | null>(null);
  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);
  const [error, setError] = useState<string | null>(null);
  const [moveWarnings, setMoveWarnings] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [restorePreview, setRestorePreview] = useState<RestorePreviewDTO | null>(null);
  const [previewingRestore, setPreviewingRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // TS-175: the version whose nickname is being typed. Switching to another version closes the box
  // (a nickname typed for one version used to be saved onto the next one opened).
  const [labelVersionId, setLabelVersionId] = useState<string | null>(null);
  const editingLabel = labelVersionId !== null && labelVersionId === detail?.id;
  const [labelInput, setLabelInput] = useState("");
  // TS-166: a version label being typed counts as unsaved input (TS-159).
  useUnsavedChanges("plan-label", editingLabel && labelInput.trim() !== (detail?.label ?? ""));
  const [savingLabel, setSavingLabel] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [compareFromId, setCompareFromId] = useState("");
  const [compareToId, setCompareToId] = useState("");
  const [comparison, setComparison] = useState<PlanVersionComparisonDTO | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [planView, setPlanView] = useState<"list" | "floorplan">("list");
  // FR-7.5: session-scoped undo/redo of manual moves. Deliberately plain component state, not
  // persisted anywhere -- per the requirement, undo/redo only ever applies "within the user's
  // current editing session," and after a reload the user goes through version history instead.
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);
  const [undoRedoBusy, setUndoRedoBusy] = useState(false);

  const guestName = (id: string) => {
    const g = guests.find((g) => g.id === id);
    return g ? `${g.firstName} ${g.lastName}` : id;
  };

  const tableLabel = (id: string) => tables.find((t) => t.id === id)?.label ?? id;

  // FR-7.7: a 409 conflict carries the fresh, currently-committed plan version alongside the
  // message -- pulling it out lets every write handler refresh the view in one step instead of a
  // second round-trip, and shows the user what changed rather than a bare error.
  function conflictPlanVersion(err: unknown): PlanVersionDetailDTO | null {
    if (err instanceof ApiError && err.status === 409 && err.data?.planVersion) {
      return err.data.planVersion as PlanVersionDetailDTO;
    }
    return null;
  }

  async function loadVersions(selectId?: string) {
    const res = await api.get<{ planVersions: PlanVersionDTO[] }>(
      `/api/v1/weddings/${weddingId}/plan-versions`
    );
    setVersions(res.planVersions);
    // FR-5.6 (TS-8): when nothing specific was requested (the tab's initial load), default to the
    // actual Current version, not just the highest versionNumber -- a Comparison Draft can now
    // outnumber Current without replacing it. An explicit selectId (picking from the dropdown,
    // or the version just generated) always wins regardless of its isCurrent state.
    const idToLoad =
      selectId ?? res.planVersions.find((v) => v.isCurrent)?.id ?? res.planVersions[0]?.id;
    if (idToLoad) {
      const d = await api.get<{ planVersion: PlanVersionDetailDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${idToLoad}`
      );
      setDetail(d.planVersion);
    } else {
      setDetail(null);
    }
  }

  useEffect(() => {
    Promise.all([
      // eslint-disable-next-line react-hooks/set-state-in-effect -- TS-176: loads the versions and tables when the tab opens.
      loadVersions(),
      api
        .get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`)
        .then((res) => setTables(res.tables)),
    ])
      .catch(() => setError("Couldn't load seating plans."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId]);

  // FR-7.7: "a saved change made by one user becomes visible to the others within five seconds
  // without a manual refresh." Polls the Current Plan Version every 4s and merges in whatever's
  // actually new (by comparing revision, so an unchanged plan never re-renders). Skipped entirely
  // while any write from this tab is in flight, so a poll landing mid-action can't clobber an
  // optimistic update or yank the view out from under a click. Scoped to the current version
  // only, matching FR-7.7's own "the same wedding or Current Plan Version" wording -- broader
  // live sync for guests/rules/tables/comments isn't built in this pass (see the README).
  useEffect(() => {
    if (!detail?.isCurrent) return;
    const planVersionId = detail.id;
    const busy = movingIds.size > 0 || undoRedoBusy || statusUpdating || savingLabel || restoring || generating;
    if (busy) return;
    const interval = setInterval(async () => {
      try {
        const res = await api.get<{ planVersion: PlanVersionDetailDTO }>(
          `/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}`
        );
        // TS-166: a poll that set off before a move can come back after it -- only ever take a
        // newer copy, never an older one (the moved guest used to snap back).
        setDetail((cur) => {
          if (!cur || cur.id !== planVersionId || cur.revision >= res.planVersion.revision) return cur;
          return res.planVersion;
        });
        setVersions((vs) =>
          vs.map((v) => (v.id === res.planVersion.id && v.revision < res.planVersion.revision ? res.planVersion : v))
        );
      } catch {
        // Best-effort background sync -- a transient failure here isn't worth surfacing as an
        // error; the next tick tries again.
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [
    detail?.id,
    detail?.isCurrent,
    weddingId,
    movingIds,
    undoRedoBusy,
    statusUpdating,
    savingLabel,
    restoring,
    generating,
  ]);

  async function onGenerate() {
    setError(null);
    setConflicts([]);
    setMoveWarnings([]);
    setRestorePreview(null);
    setUndoStack([]);
    setRedoStack([]);
    setScoreReport(null);
    setShowScoreDetail(false);
    setGenerating(true);
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO; scoreReport?: PlanVersionScoreReportDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/generate`,
        { makeCurrent: !saveAsDraft }
      );
      await loadVersions(res.planVersion.id);
      setScoreReport(res.scoreReport ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.fieldErrors?.conflicts) {
        setConflicts(err.fieldErrors.conflicts as unknown as string[]);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't generate a plan.");
      }
    } finally {
      setGenerating(false);
    }
  }

  async function onSelectVersion(id: string) {
    setMoveWarnings([]);
    setRestorePreview(null);
    setScoreReport(null);
    setShowScoreDetail(false);
    // Undo/redo history is scoped to whichever version was current when each move was made --
    // switching what's being viewed ends that continuity rather than risk replaying a stale move
    // against the wrong version later.
    setUndoStack([]);
    setRedoStack([]);
    // TS-151: a version that can't be loaded says so instead of failing silently.
    try {
      const d = await api.get<{ planVersion: PlanVersionDetailDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${id}`
      );
      setError(null);
      setDetail(d.planVersion);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open that version.");
    }
  }

  // Returns what happened (error, or warnings) so a caller that wants to show feedback right at
  // the point of interaction -- the floor plan's drag-and-drop, see PlanFloorPlan below -- can do
  // so without forcing the user back up to the top-of-tab banner this also still populates.
  function onMoveGuest(guestId: string, tableId: string): Promise<MoveGuestResult> {
    if (!detail || !tableId) return Promise.resolve({});
    markMoving(guestId, true);
    return queueMove(() => moveGuest(guestId, tableId));
  }

  async function moveGuest(guestId: string, tableId: string): Promise<MoveGuestResult> {
    const current = detailRef.current;
    if (!current) return {};
    setError(null);
    setMoveWarnings([]);
    const priorTableId = current.assignments.find((a) => a.guestId === guestId)?.tableId ?? null;
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${current.id}/assignments`,
        { guestId, tableId, expectedRevision: current.revision }
      );
      detailRef.current = res.planVersion;
      setDetail(res.planVersion);
      setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
      setMoveWarnings(res.warnings);
      if (priorTableId !== tableId) {
        setUndoStack((s) => [
          ...s,
          {
            guestId,
            priorTableId,
            toTableId: tableId,
            description: `move ${guestName(guestId)} to "${tableLabel(tableId)}"`,
          },
        ]);
        setRedoStack([]);
      }
      return { warnings: res.warnings };
    } catch (err) {
      // FR-7.7: this plan changed under us -- show the fresh state instead of leaving the view
      // stale, and don't record an undo entry for a move that never actually applied.
      const fresh = conflictPlanVersion(err);
      if (fresh) {
        detailRef.current = fresh;
        setDetail(fresh);
        setVersions((vs) => vs.map((v) => (v.id === fresh.id ? fresh : v)));
      }
      const message = err instanceof ApiError ? err.message : "Couldn't move that guest.";
      setError(message);
      return { error: message };
    } finally {
      markMoving(guestId, false);
    }
  }

  // FR-7.5: undo and redo are each "replay this one guest's move-or-unassign action" -- they
  // never reverse another user's later saved change. Before replaying, re-fetch the plan and
  // check the guest is still exactly where this action last left them; if anyone (this user via
  // another tab, or a collaborator) has since moved them again, the stale entry is dropped
  // instead of blindly overwriting that newer change, and the current state is shown instead.
  async function onUndo() {
    if (undoStack.length === 0 || !detail || undoRedoBusy) return;
    await replay(undoStack[undoStack.length - 1], "undo");
  }

  async function onRedo() {
    if (redoStack.length === 0 || !detail || undoRedoBusy) return;
    await replay(redoStack[redoStack.length - 1], "redo");
  }

  // TS-175: undo and redo go through the same queue as moves and status changes, and send the
  // plan's revision. They used to run alongside it and never updated the copy the queue works
  // from, so the move (or "Move to review") right after an undo was refused as a stale change.
  async function replay(entry: UndoEntry, kind: "undo" | "redo") {
    const [expectedAt, target] = kind === "undo" ? [entry.toTableId, entry.priorTableId] : [entry.priorTableId, entry.toTableId];
    const dropEntry = () => (kind === "undo" ? setUndoStack((s) => s.slice(0, -1)) : setRedoStack((s) => s.slice(0, -1)));
    setError(null);
    setUndoRedoBusy(true);
    try {
      await queueMove(async () => {
        const current = detailRef.current;
        if (!current) return;
        const fresh = await api.get<{ planVersion: PlanVersionDetailDTO }>(
          `/api/v1/weddings/${weddingId}/plan-versions/${current.id}`
        );
        const currentTableId = fresh.planVersion.assignments.find((a) => a.guestId === entry.guestId)?.tableId ?? null;
        if (currentTableId !== expectedAt) {
          detailRef.current = fresh.planVersion;
          setDetail(fresh.planVersion);
          dropEntry();
          setError(
            `Can't ${kind} that — ${guestName(entry.guestId)}'s seat has changed since then (possibly by another collaborator).`
          );
          return;
        }
        const res = await api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
          `/api/v1/weddings/${weddingId}/plan-versions/${current.id}/assignments`,
          { guestId: entry.guestId, tableId: target, expectedRevision: fresh.planVersion.revision }
        );
        detailRef.current = res.planVersion;
        setDetail(res.planVersion);
        setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
        setMoveWarnings(res.warnings);
        dropEntry();
        if (kind === "undo") setRedoStack((r) => [...r, entry]);
        else setUndoStack((u) => [...u, entry]);
      });
    } catch (err) {
      const fresh = conflictPlanVersion(err);
      if (fresh) {
        detailRef.current = fresh;
        setDetail(fresh);
        setVersions((vs) => vs.map((v) => (v.id === fresh.id ? fresh : v)));
      }
      setError(err instanceof ApiError ? err.message : `Couldn't ${kind} that move.`);
    } finally {
      setUndoRedoBusy(false);
    }
  }

  async function onSetStatus(newStatus: PlanVersionStatusValue) {
    if (!detail) return;
    setError(null);
    setStatusUpdating(true);
    try {
      // TS-170: queued behind any move still on its way, and sent with the plan as that move left it
      // -- clicking "Move to review" right after a move used to be refused as a stale change.
      const res = await queueMove(() => {
        const current = detailRef.current!;
        return api.post<{ planVersion: PlanVersionDetailDTO }>(
          `/api/v1/weddings/${weddingId}/plan-versions/${current.id}/status`,
          { status: newStatus, expectedRevision: current.revision }
        );
      });
      detailRef.current = res.planVersion;
      setDetail(res.planVersion);
      setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
    } catch (err) {
      const fresh = conflictPlanVersion(err);
      if (fresh) {
        setDetail(fresh);
        setVersions((vs) => vs.map((v) => (v.id === fresh.id ? fresh : v)));
      }
      setError(err instanceof ApiError ? err.message : "Couldn't update the plan's status.");
    } finally {
      setStatusUpdating(false);
    }
  }

  async function onPreviewRestore() {
    if (!detail) return;
    setError(null);
    setPreviewingRestore(true);
    try {
      const res = await api.get<{ preview: RestorePreviewDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/restore-preview`
      );
      setRestorePreview(res.preview);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't preview that restore.");
    } finally {
      setPreviewingRestore(false);
    }
  }

  async function onConfirmRestore() {
    if (!detail) return;
    setError(null);
    setRestoring(true);
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/restore`
      );
      setRestorePreview(null);
      setUndoStack([]);
      setRedoStack([]);
      await loadVersions(res.planVersion.id);
      setMoveWarnings(res.warnings);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't restore that version.");
    } finally {
      setRestoring(false);
    }
  }

  async function onSaveLabel() {
    if (!detail) return;
    setError(null);
    setSavingLabel(true);
    try {
      // TS-170: queued like a move (see onSetStatus).
      const label = labelInput;
      const versionId = labelVersionId;
      const res = await queueMove(() => {
        const current = detailRef.current!;
        if (current.id !== versionId) throw new Error("That version isn't open any more — nothing was saved.");
        return api.patch<{ planVersion: PlanVersionDetailDTO }>(
          `/api/v1/weddings/${weddingId}/plan-versions/${current.id}`,
          { label, expectedRevision: current.revision }
        );
      });
      detailRef.current = res.planVersion;
      setDetail(res.planVersion);
      setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
      setLabelVersionId(null);
    } catch (err) {
      const fresh = conflictPlanVersion(err);
      if (fresh) {
        setDetail(fresh);
        setVersions((vs) => vs.map((v) => (v.id === fresh.id ? fresh : v)));
      }
      setError(err instanceof ApiError ? err.message : "Couldn't save that label.");
    } finally {
      setSavingLabel(false);
    }
  }

  async function onCompare() {
    if (!compareFromId || !compareToId) return;
    setCompareError(null);
    setComparing(true);
    try {
      const res = await api.get<{ comparison: PlanVersionComparisonDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/compare?from=${compareFromId}&to=${compareToId}`
      );
      setComparison(res.comparison);
    } catch (err) {
      setCompareError(err instanceof ApiError ? err.message : "Couldn't compare those versions.");
    } finally {
      setComparing(false);
    }
  }

  if (loading) return <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading seating plans...</p>;

  // FR-6.1: "Unassigned/Needs Reassignment guests appear in a separate prominent area rather than
  // a false valid table." A Needs Reassignment guest's seat assignment row still exists (they're
  // not literally unassigned), but showing them nested under their no-longer-valid table would
  // read as a normal, rule-respecting placement -- so both views pull them out into their own
  // area, same as Unassigned, rather than leaving them in `grouped` with just an inline badge.
  const grouped = new Map<string, { tableLabel: string; guests: { guestId: string; guestName: string }[] }>();
  const needsReassignmentGuests: { guestId: string; guestName: string; tableId: string; tableLabel: string }[] = [];
  if (detail) {
    for (const a of detail.assignments) {
      if (a.needsReassignment) {
        needsReassignmentGuests.push({ guestId: a.guestId, guestName: a.guestName, tableId: a.tableId, tableLabel: a.tableLabel });
        continue;
      }
      if (!grouped.has(a.tableId)) grouped.set(a.tableId, { tableLabel: a.tableLabel, guests: [] });
      grouped.get(a.tableId)!.guests.push({ guestId: a.guestId, guestName: a.guestName });
    }
  }
  // TS-126: every seat taken at each table -- including guests flagged Needs Reassignment, who
  // still physically sit there -- counted by headcount, so the list can show free seats.
  const headcountByGuest = new Map(guests.map((g) => [g.id, g.headcount]));
  const seatsTakenByTable = new Map<string, number>();
  for (const a of detail?.assignments ?? []) {
    seatsTakenByTable.set(a.tableId, (seatsTakenByTable.get(a.tableId) ?? 0) + (headcountByGuest.get(a.guestId) ?? 1));
  }
  const canEditThisVersion = canEdit && Boolean(detail?.isCurrent);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Seating plan</h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Generates a new version — hard rules (must/must not sit together, accessible tables,
            capacity) are never violated; guests who can&apos;t be placed are listed below rather
            than silently dropped.
          </p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button
              onClick={onGenerate}
              disabled={generating}
              className="min-h-11 rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
            >
              {generating ? "Generating..." : "Generate new plan"}
            </button>
            {/* FR-5.6: chosen upfront, before the run -- an unsuccessful run (a hard-rule
                conflict) only ever produces a conflict report either way, nothing is saved. */}
            <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={saveAsDraft}
                onChange={(e) => setSaveAsDraft(e.target.checked)}
                disabled={generating}
              />
              Save as comparison draft (don&apos;t replace the current version)
            </label>
          </div>
        )}
      </div>
      {!canEdit && (
        <p className="mb-4 rounded-md bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300">
          {/* TS-166: a Couple member with Comment access can still approve -- don't call that view-only. */}
          {canApprove
            ? "You can review and approve this seating plan, but not change who sits where."
            : "You have view-only access to this wedding's seating plan."}
        </p>
      )}

      {conflicts.length > 0 && (
        <div className="mb-6 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950 p-4">
          <p className="mb-2 text-sm font-medium text-red-800 dark:text-red-300">
            These rule conflicts need to be fixed first:
          </p>
          <ul className="list-inside list-disc text-sm text-red-700 dark:text-red-400">
            {conflicts.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* FR-5.3: shown once, right after the generation run that produced it -- not persisted, so
          reloading or switching versions clears it, same as the moveWarnings/conflicts above. */}
      {scoreReport && (
        <div className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              Soft-preference results — weighting-configuration version {scoreReport.ruleConfigVersion},
              total score {scoreReport.totalScore}
            </p>
            <button
              onClick={() => setShowScoreDetail((s) => !s)}
              aria-expanded={showScoreDetail}
              className="shrink-0 text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline"
            >
              {showScoreDetail ? "Hide calculation" : "How is this calculated?"}
            </button>
          </div>
          {scoreReport.preferences.length > 0 && (
            <ul className="mb-2 list-inside list-disc text-sm">
              {scoreReport.preferences.map((p, i) => (
                <li key={i} className={p.satisfied ? "text-neutral-700 dark:text-neutral-300" : "text-amber-700 dark:text-amber-400"}>
                  {p.guestAName} and {p.guestBName} (
                  {p.type === "PREFER_NEAR" ? "prefer near each other" : "avoid each other"}):{" "}
                  {p.satisfied ? "satisfied" : "not satisfied"}
                </li>
              ))}
            </ul>
          )}
          {scoreReport.purposeTables.length > 0 && (
            <ul className="mb-2 list-inside list-disc text-sm text-neutral-700 dark:text-neutral-300">
              {scoreReport.purposeTables.map((t) => (
                <li key={t.tableId}>
                  &quot;{t.tableLabel}&quot; Purpose table ({t.criterionType.toLowerCase().replace("_", " ")}
                  : {t.criterionValue}): {t.matchingGuestsSeatedHere} of {t.matchingGuestsTotal} matching
                  guest(s) seated here
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            Side-Mixing ({scoreReport.sideMixing.setting}): {scoreReport.sideMixing.mixedTableCount} mixed
            table(s), {scoreReport.sideMixing.singleSideTableCount} single-side table(s)
            {scoreReport.sideMixing.singleSideOnlyViolations > 0
              ? `, ${scoreReport.sideMixing.singleSideOnlyViolations} Single-Side-Only table(s) seated both sides anyway`
              : ""}
            .
          </p>
          {showScoreDetail && (
            <pre className="mt-3 overflow-x-auto rounded bg-neutral-50 dark:bg-neutral-900 p-3 text-xs text-neutral-600 dark:text-neutral-300">
              {JSON.stringify(RULE_WEIGHT_CONFIG, null, 2)}
            </pre>
          )}
        </div>
      )}

      {versions.length > 1 && (
        <div className="mb-6">
          <label htmlFor="plan-version-select" className="mb-1 block text-sm font-medium">
            Version
          </label>
          <select
            id="plan-version-select"
            className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
            value={detail?.id ?? ""}
            onChange={(e) => onSelectVersion(e.target.value)}
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.versionNumber}
                {v.label ? ` — ${v.label}` : ""}
                {v.restoredFromVersionNumber ? ` (restored from v${v.restoredFromVersionNumber})` : ""} —{" "}
                {v.isComplete ? "complete" : "incomplete"}, {STATUS_LABEL[v.status]} (
                {new Date(v.createdAt).toLocaleString()})
              </option>
            ))}
          </select>
        </div>
      )}

      {versions.length > 1 && (
        <div className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
          <button
            aria-expanded={showCompare}
            onClick={() => {
              setShowCompare((s) => !s);
              if (!showCompare) {
                setCompareFromId(versions[1]?.id ?? "");
                setCompareToId(versions[0]?.id ?? "");
              }
            }}
            className="text-sm font-medium text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            {showCompare ? "Hide version comparison" : "Compare two versions..."}
          </button>
          {showCompare && (
            <div className="mt-3">
              <div className="mb-3 flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="compare-from" className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    From
                  </label>
                  <select
                    id="compare-from"
                    className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                    value={compareFromId}
                    onChange={(e) => setCompareFromId(e.target.value)}
                  >
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {versionOptionLabel(v)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="compare-to" className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    To
                  </label>
                  <select
                    id="compare-to"
                    className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                    value={compareToId}
                    onChange={(e) => setCompareToId(e.target.value)}
                  >
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {versionOptionLabel(v)}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={onCompare}
                  disabled={comparing || !compareFromId || !compareToId}
                  className="min-h-11 rounded-md bg-neutral-900 dark:bg-neutral-100 px-3 py-1.5 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
                >
                  {comparing ? "Comparing..." : "Compare"}
                </button>
              </div>
              {compareError && <p role="alert" className="mb-2 text-sm text-red-600 dark:text-red-400">{compareError}</p>}
              {comparison && (
                <div>
                  <p className="mb-2 text-sm text-neutral-600 dark:text-neutral-300">
                    v{comparison.from.versionNumber}
                    {comparison.from.label ? ` (${comparison.from.label})` : ""} →{" "}
                    v{comparison.to.versionNumber}
                    {comparison.to.label ? ` (${comparison.to.label})` : ""}: {comparison.summary.movedCount}{" "}
                    moved, {comparison.summary.addedCount} added, {comparison.summary.removedCount} removed,{" "}
                    {comparison.summary.unchangedCount} unchanged
                  </p>
                  <div className="max-h-96 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 bg-neutral-50 dark:bg-neutral-900">
                        <tr>
                          <th className="px-3 py-2 font-medium">Guest</th>
                          <th className="px-3 py-2 font-medium">From table</th>
                          <th className="px-3 py-2 font-medium">To table</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.guests.map((g) => (
                          <tr key={g.guestId} className="border-t border-neutral-100 dark:border-neutral-800">
                            <td className="px-3 py-1.5">{g.guestName}</td>
                            <td className="px-3 py-1.5 text-neutral-500 dark:text-neutral-400">{g.fromTableLabel ?? "—"}</td>
                            <td className="px-3 py-1.5 text-neutral-500 dark:text-neutral-400">{g.toTableLabel ?? "—"}</td>
                            <td className="px-3 py-1.5">
                              <span
                                className={`rounded px-2 py-0.5 text-xs font-medium ${COMPARISON_STATUS_CLASS[g.status]}`}
                              >
                                {COMPARISON_STATUS_LABEL[g.status]}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!detail ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          No plan generated yet — add guests and tables, then click &ldquo;Generate new
          plan&rdquo;.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                detail.isComplete ? "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400" : "bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-400"
              }`}
            >
              Version {detail.versionNumber} — {detail.isComplete ? "complete" : "incomplete"}
            </span>
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[detail.status]}`}>
              {STATUS_LABEL[detail.status]}
            </span>
            <span className="text-sm text-neutral-500 dark:text-neutral-400">
              {detail.assignedGuestCount} seated, {detail.unassignedGuestCount} unassigned
            </span>
            {!canEdit ? (
              detail.label && <span className="text-sm text-neutral-500 dark:text-neutral-400">“{detail.label}”</span>
            ) : editingLabel ? (
              <span className="flex items-center gap-1">
                <input
                  autoFocus
                  aria-label="Version nickname"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  placeholder="Version nickname"
                  maxLength={100}
                  className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                />
                <button
                  onClick={onSaveLabel}
                  disabled={savingLabel}
                  className="min-h-11 rounded-md bg-neutral-900 dark:bg-neutral-100 px-2 py-1 text-xs font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
                >
                  {savingLabel ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() => setLabelVersionId(null)}
                  disabled={savingLabel}
                  className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-xs font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => {
                  setLabelInput(detail.label ?? "");
                  setLabelVersionId(detail.id);
                }}
                className="text-sm text-neutral-500 dark:text-neutral-400 underline hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                {detail.label ? `“${detail.label}” (rename)` : "Add a nickname..."}
              </button>
            )}
          </div>

          {detail.status === "APPROVED" && (
            <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3">
              <span className="text-sm font-medium">Export:</span>
              <a
                href={`/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/export/chart`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                Seating chart (PDF)
              </a>
              <a
                href={`/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/export/lookup`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                Guest lookup list (PDF)
              </a>
              <a
                href={`/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/export/cards`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                Place cards (PDF)
              </a>
            </div>
          )}

          {!detail.isCurrent && (
            <div className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
              <p className="mb-2 text-sm text-neutral-500 dark:text-neutral-400">
                This is a past version — status can only be changed on the current one. Restoring
                it makes a brand-new current version with a copy of its assignments,
                re-checked against today&apos;s guests/tables/rules — it never rewrites this version or
                anything newer.
              </p>
              {canEdit && restorePreview?.sourceVersionNumber !== detail.versionNumber && (
                <button
                  onClick={onPreviewRestore}
                  disabled={previewingRestore}
                  className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                >
                  {previewingRestore ? "Checking..." : `Restore version ${detail.versionNumber}...`}
                </button>
              )}
              {canEdit && restorePreview && restorePreview.sourceVersionNumber === detail.versionNumber && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950 p-3">
                  <p className="mb-2 text-sm font-medium text-amber-800 dark:text-amber-300">
                    Restoring version {restorePreview.sourceVersionNumber} will create a new
                    version {restorePreview.isComplete ? "(complete)" : "(incomplete)"}: {restorePreview.keptCount}{" "}
                    guest(s) kept exactly as seated, {restorePreview.unassignedGuestIds.length} left
                    unassigned.
                  </p>
                  {restorePreview.droppedGuests.length > 0 && (
                    <ul className="mb-2 list-inside list-disc text-sm text-amber-700 dark:text-amber-400">
                      {restorePreview.droppedGuests.map((d, i) => (
                        <li key={i}>
                          {d.guestName} — {d.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                  {restorePreview.warnings.length > 0 && (
                    <ul className="mb-2 list-inside list-disc text-sm text-amber-700 dark:text-amber-400">
                      {restorePreview.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={onConfirmRestore}
                      disabled={restoring}
                      className="rounded-md bg-neutral-900 dark:bg-neutral-100 min-h-11 px-3 py-1.5 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
                    >
                      {restoring ? "Restoring..." : "Confirm restore"}
                    </button>
                    <button
                      onClick={() => setRestorePreview(null)}
                      disabled={restoring}
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {detail.isCurrent && (canEdit || canApprove) && (
            <div className="mb-6 flex flex-wrap items-center gap-2">
              {canEdit && detail.status === "DRAFT" && (
                <button
                  onClick={() => onSetStatus("IN_REVIEW")}
                  disabled={statusUpdating}
                  className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                >
                  Move to review
                </button>
              )}
              {detail.status === "IN_REVIEW" && (
                <>
                  {canEdit && (
                    <button
                      onClick={() => onSetStatus("DRAFT")}
                      disabled={statusUpdating}
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                    >
                      Move back to draft
                    </button>
                  )}
                  {canApprove && (
                    <button
                      onClick={() => onSetStatus("APPROVED")}
                      disabled={statusUpdating || !detail.isComplete}
                      title={!detail.isComplete ? "Every guest must be seated before a plan can be approved." : undefined}
                      className="rounded-md bg-green-700 dark:bg-green-600 min-h-11 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800 dark:hover:bg-green-500 disabled:opacity-50"
                    >
                      Approve
                    </button>
                  )}
                  {canApprove && !detail.isComplete && (
                    <span className="text-sm text-neutral-500 dark:text-neutral-400">
                      Seat every guest before this can be approved.
                    </span>
                  )}
                </>
              )}
              {canEdit && detail.status === "APPROVED" && (
                <button
                  onClick={() => onSetStatus("IN_REVIEW")}
                  disabled={statusUpdating}
                  className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                >
                  Reopen for review
                </button>
              )}
            </div>
          )}

          {detail.status === "APPROVED" && detail.modifiedSinceApproval.active && (
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950 p-4">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                Modified since approval
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-400">
                First change {new Date(detail.modifiedSinceApproval.firstModifiedAt!).toLocaleString()},
                latest {new Date(detail.modifiedSinceApproval.latestModifiedAt!).toLocaleString()}.
                Approval doesn&apos;t lock anything — this plan is still Approved, but review what
                changed.
              </p>
            </div>
          )}

          {detail.warnings.length > 0 && (
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950 p-4">
              <p className="mb-2 text-sm font-medium text-amber-800 dark:text-amber-300">Notes on this plan:</p>
              <ul className="list-inside list-disc text-sm text-amber-700 dark:text-amber-400">
                {detail.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {moveWarnings.length > 0 && (
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950 p-4">
              <p className="mb-2 text-sm font-medium text-amber-800 dark:text-amber-300">
                That move was made, but note:
              </p>
              <ul className="list-inside list-disc text-sm text-amber-700 dark:text-amber-400">
                {moveWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {!canEditThisVersion && (
            <p className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
              {canEdit
                ? "This is a past version — guests can only be manually moved on the current one."
                : "You have view-only access to this wedding's seating plan — manual moves are turned off."}
            </p>
          )}

          {canEditThisVersion && (undoStack.length > 0 || redoStack.length > 0) && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <button
                data-testid="undo-button"
                onClick={onUndo}
                disabled={undoStack.length === 0 || undoRedoBusy || movingIds.size > 0}
                title={undoStack.length > 0 ? `Undo: ${undoStack[undoStack.length - 1].description}` : undefined}
                className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                {undoRedoBusy ? "Working..." : "Undo"}
              </button>
              <button
                data-testid="redo-button"
                onClick={onRedo}
                disabled={redoStack.length === 0 || undoRedoBusy || movingIds.size > 0}
                title={redoStack.length > 0 ? `Redo: ${redoStack[redoStack.length - 1].description}` : undefined}
                className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                Redo
              </button>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Undo/redo covers this browser session&apos;s own moves only — reload or switch
                versions and use version history instead.
              </span>
            </div>
          )}

          {planView === "list" && detail.unassignedGuestIds.length > 0 && (
            <div className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
              <p className="mb-2 text-sm font-medium">Unassigned guests</p>
              <ul className="flex flex-col gap-2">
                {detail.unassignedGuestIds.map((id) => (
                  <li key={id} className="flex items-center justify-between gap-2 text-sm">
                    <span>{guestName(id)}</span>
                    {canEditThisVersion && (
                      <select
                        aria-label={`Move ${guestName(id)} to a table`}
                        className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm disabled:opacity-50"
                        value=""
                        disabled={movingIds.has(id)}
                        onChange={(e) => onMoveGuest(id, e.target.value)}
                      >
                        <option value="" disabled>
                          {movingIds.has(id) ? "Seating..." : "Seat at..."}
                        </option>
                        {tables.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {planView === "list" && needsReassignmentGuests.length > 0 && (
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50/40 dark:bg-amber-950/40 p-4">
              <p className="mb-1 text-sm font-medium text-amber-800 dark:text-amber-300">Needs reassignment</p>
              <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
                Their current table no longer fits a hard rule for them (e.g. an edited field, or a
                table setting changed) — shown here rather than under that table, since it&apos;s no
                longer a valid placement for them.
              </p>
              <ul className="flex flex-col gap-2">
                {needsReassignmentGuests.map((g) => (
                  <li key={g.guestId} className="flex items-center justify-between gap-2 text-sm">
                    <span>
                      {g.guestName}{" "}
                      <span className="text-xs text-neutral-400 dark:text-neutral-500">(currently at {g.tableLabel})</span>
                    </span>
                    {canEditThisVersion && (
                      <select
                        aria-label={`Move ${g.guestName} to a different table`}
                        className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm disabled:opacity-50"
                        value=""
                        disabled={movingIds.has(g.guestId)}
                        onChange={(e) => onMoveGuest(g.guestId, e.target.value)}
                      >
                        <option value="" disabled>
                          {movingIds.has(g.guestId) ? "Moving..." : "Move to..."}
                        </option>
                        {tables
                          .filter((t) => t.id !== g.tableId)
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.label}
                            </option>
                          ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Tables</h3>
            <div className="flex gap-1 rounded-md border border-neutral-300 dark:border-neutral-600 p-0.5 text-sm">
              <button
                onClick={() => setPlanView("list")}
                aria-pressed={planView === "list"}
                className={`rounded px-2 py-1 ${planView === "list" ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"}`}
              >
                List
              </button>
              <button
                onClick={() => setPlanView("floorplan")}
                aria-pressed={planView === "floorplan"}
                className={`rounded px-2 py-1 ${planView === "floorplan" ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"}`}
              >
                Floor plan
              </button>
            </div>
          </div>

          {planView === "floorplan" ? (
            <PlanFloorPlan
              tables={tables}
              grouped={grouped}
              unassignedGuestIds={detail.unassignedGuestIds}
              needsReassignmentGuests={needsReassignmentGuests}
              guestName={guestName}
              onMoveGuest={onMoveGuest}
              canEditThisVersion={canEditThisVersion}
              movingIds={movingIds}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {/* `grouped`'s insertion order already follows the assignments the API returns
                  (now table-ordered numerically at the source), but this list is re-sorted
                  explicitly too rather than depending on that indirectly. */}
              {/* TS-126: every table in the wedding, not just the ones someone is seated at -- an
                  empty table used to be missing from this list entirely, and nothing showed how
                  many seats were free. (A table this version seats someone at but that no longer
                  exists can't happen: removing a table removes its seats.) */}
              {[...tables]
                .sort((a, b) => compareTableLabels(a.label, b.label))
                .map((table) => {
                  const tableId = table.id;
                  const t = grouped.get(tableId) ?? { tableLabel: table.label, guests: [] };
                  const taken = seatsTakenByTable.get(tableId) ?? 0;
                  return (
                <div key={tableId} className="rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3">
                  <p className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {t.tableLabel}
                      {table.isAccessible && (
                        <span className="ml-2 rounded bg-blue-50 dark:bg-blue-950 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-400">
                          accessible
                        </span>
                      )}
                    </span>
                    <span
                      className={`text-sm ${taken > table.capacity ? "font-medium text-red-600 dark:text-red-400" : "text-neutral-500 dark:text-neutral-400"}`}
                    >
                      {taken === 0 ? `Empty — ${table.capacity} seats free` : `${taken}/${table.capacity} seated`}
                    </span>
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {t.guests.map((g) => (
                      <li key={g.guestId} className="flex items-center justify-between gap-2 text-sm">
                        <span>{g.guestName}</span>
                        {canEditThisVersion && (
                          <select
                            aria-label={`Move ${g.guestName} to a different table`}
                            className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-xs disabled:opacity-50"
                            value=""
                            disabled={movingIds.has(g.guestId)}
                            onChange={(e) => onMoveGuest(g.guestId, e.target.value)}
                          >
                            <option value="" disabled>
                              {movingIds.has(g.guestId) ? "Moving..." : "Move to..."}
                            </option>
                            {tables
                              .filter((table) => table.id !== tableId)
                              .map((table) => (
                                <option key={table.id} value={table.id}>
                                  {table.label}
                                </option>
                              ))}
                          </select>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                  );
                })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// FR-7.1: a user with Edit permission can drag a guest from one table to another in a visual
// view. Every way of making that move calls the same onMoveGuest handler the list view's "Move
// to..." dropdown uses, so FR-7.2 (hard-rule blocking) and FR-7.3 (soft-rule warnings) are
// enforced identically no matter which UI made the move.
//
// TS-90: three ways in, all direct -- none goes through a dialog:
// - mouse: the native HTML5 drag-and-drop API (a guest chip is the drag source, a table box the
//   drop target), as before;
// - touch/pen: native HTML5 drag doesn't fire for a finger on most mobile browsers, so a chip
//   also runs its own pointer-driven drag for non-mouse pointers -- a label follows the finger
//   and whichever table box is under it on release is the drop target;
// - keyboard, or a tap/click without dragging: pick-and-place -- pick a guest up (Enter/Space,
//   or tap), then choose a table (Enter/Space, or tap); Escape cancels.
// Moves are to a table, never a numbered seat: Seatwise deliberately has no seat numbers (see
// tables.no-seat-or-chair-number-feature-exists.spec.ts).
function PlanFloorPlan({
  tables,
  grouped,
  unassignedGuestIds,
  needsReassignmentGuests,
  guestName,
  onMoveGuest,
  canEditThisVersion,
  movingIds,
}: {
  tables: SeatingTableDTO[];
  grouped: Map<string, { tableLabel: string; guests: { guestId: string; guestName: string }[] }>;
  unassignedGuestIds: string[];
  needsReassignmentGuests: { guestId: string; guestName: string; tableId: string; tableLabel: string }[];
  guestName: (id: string) => string;
  onMoveGuest: (guestId: string, tableId: string) => Promise<MoveGuestResult>;
  canEditThisVersion: boolean;
  movingIds: ReadonlySet<string>;
}) {
  const [dragOverTableId, setDragOverTableId] = useState<string | null>(null);
  // Feedback for the table that was just dropped onto, shown right there on the canvas instead of
  // only in the banner at the top of the tab -- so a rule violation is visible without scrolling
  // back up, especially on a plan with many tables. Auto-dismisses; a fresh drop replaces it.
  const [dropFeedback, setDropFeedback] = useState<{ tableId: string; kind: "error" | "warning"; message: string } | null>(
    null
  );
  // TS-90: the guest currently picked up by keyboard or tap, waiting for a table to be chosen.
  const [pickedGuestId, setPickedGuestId] = useState<string | null>(null);
  // TS-90: a finger/pen drag in progress -- where to draw the label that follows it.
  const [touchDrag, setTouchDrag] = useState<{ guestId: string; x: number; y: number } | null>(null);
  const touchStart = useRef<{ guestId: string; pointerId: number; x: number; y: number; dragging: boolean } | null>(null);
  // A pointer drag can end with the browser's own click on the chip, which must not also count as a
  // tap-to-pick. Browsers don't reliably send that click after a long drag, so it's matched by
  // timing (a click right after a drag ended) -- and any new pointerdown clears it, since a genuine
  // tap always starts with one while that leftover click never does. Without the reset, a quick
  // real tap straight after a drag was swallowed too (caught on WebKit/Edge in CI).
  const dragEndedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!dropFeedback) return;
    const timer = setTimeout(() => setDropFeedback(null), 7000);
    return () => clearTimeout(timer);
  }, [dropFeedback]);

  useEffect(() => {
    if (!pickedGuestId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickedGuestId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pickedGuestId]);

  async function moveTo(guestId: string, tableId: string) {
    setPickedGuestId(null);
    setDragOverTableId(null);
    if (!canEditThisVersion) return;
    const result = await onMoveGuest(guestId, tableId);
    if (result.error) {
      setDropFeedback({ tableId, kind: "error", message: result.error });
    } else if (result.warnings && result.warnings.length > 0) {
      setDropFeedback({ tableId, kind: "warning", message: result.warnings.join(" ") });
    } else {
      setDropFeedback((cur) => (cur?.tableId === tableId ? null : cur));
    }
    // TS-175: keep a keyboard user's place -- focus the guest where they now are. The table they
    // were put at re-draws, and focus used to fall back to the top of the page.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-guest-id="${CSS.escape(guestId)}"]`)?.focus()
    );
  }

  function onGuestDragStart(e: React.DragEvent<HTMLSpanElement>, guestId: string) {
    if (!canEditThisVersion) return;
    e.dataTransfer.setData("text/plain", guestId);
    e.dataTransfer.effectAllowed = "move";
  }

  async function onTableDrop(e: React.DragEvent<HTMLDivElement>, tableId: string) {
    e.preventDefault();
    setDragOverTableId(null);
    const guestId = e.dataTransfer.getData("text/plain");
    if (!guestId) return;
    await moveTo(guestId, tableId);
  }

  function tableIdAt(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-table-id]");
    return el?.dataset.tableId ?? null;
  }

  // TS-90: finger/pen drag. Mouse keeps using native HTML5 DnD (onDragStart) -- a mouse
  // pointerdown here does nothing, so the two never both fire for one gesture.
  function onChipPointerDown(e: React.PointerEvent<HTMLSpanElement>, guestId: string) {
    dragEndedAt.current = null; // a new gesture -- whatever follows is its own click, not a drag's
    if (!canEditThisVersion || e.pointerType === "mouse") return;
    // Capture keeps the chip receiving move/up events wherever the finger goes. It can throw for a
    // pointer the browser doesn't consider active (e.g. one it has already handed to a system
    // gesture) -- the drag still works from the chip's own events, so that's not fatal.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable -- carry on uncaptured */
    }
    touchStart.current = { guestId, pointerId: e.pointerId, x: e.clientX, y: e.clientY, dragging: false };
  }

  function onChipPointerMove(e: React.PointerEvent<HTMLSpanElement>) {
    const start = touchStart.current;
    if (!start || start.pointerId !== e.pointerId) return;
    // A few pixels of wobble is still a tap, not a drag.
    if (!start.dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 8) return;
    start.dragging = true;
    setTouchDrag({ guestId: start.guestId, x: e.clientX, y: e.clientY });
    setDragOverTableId(tableIdAt(e.clientX, e.clientY));
  }

  function onChipPointerUp(e: React.PointerEvent<HTMLSpanElement>) {
    const start = touchStart.current;
    if (!start || start.pointerId !== e.pointerId) return;
    touchStart.current = null;
    setTouchDrag(null);
    if (!start.dragging) return; // a tap -- the click handler picks the guest up
    dragEndedAt.current = e.timeStamp;
    const tableId = tableIdAt(e.clientX, e.clientY);
    if (tableId) void moveTo(start.guestId, tableId);
    else setDragOverTableId(null);
  }

  function onChipPointerCancel() {
    touchStart.current = null;
    setTouchDrag(null);
    setDragOverTableId(null);
  }

  function onChipClick(e: React.MouseEvent, guestId: string) {
    // Inside a table box, a click on a chip is about the chip, never a drop on that table.
    e.stopPropagation();
    if (dragEndedAt.current !== null && e.timeStamp - dragEndedAt.current < 500) {
      dragEndedAt.current = null;
      return;
    }
    if (!canEditThisVersion) return;
    setPickedGuestId((cur) => (cur === guestId ? null : guestId));
  }

  function onChipKeyDown(e: React.KeyboardEvent, guestId: string) {
    if (!canEditThisVersion || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    e.stopPropagation();
    setPickedGuestId((cur) => (cur === guestId ? null : guestId));
  }

  const chipHandlers: GuestChipHandlers = {
    onDragStart: onGuestDragStart,
    onPointerDown: onChipPointerDown,
    onPointerMove: onChipPointerMove,
    onPointerUp: onChipPointerUp,
    onPointerCancel: onChipPointerCancel,
    onClick: onChipClick,
    onKeyDown: onChipKeyDown,
  };

  const width = Math.max(760, ...tables.map((t) => (t.positionX ?? 40) + PLAN_BOX_WIDTH + 40));
  const height = Math.max(480, ...tables.map((t) => (t.positionY ?? 40) + PLAN_BOX_HEIGHT + 40));

  return (
    <div>
      <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
        {canEditThisVersion
          ? "Drag a guest onto a different table to move them — or tap or press Enter on a guest, then on a table. Hard rules are enforced exactly as with the dropdowns above."
          : "View-only — dragging guests between tables is turned off for your access level."}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {pickedGuestId ? `${guestName(pickedGuestId)} picked up. Choose a table, or press Escape to cancel.` : ""}
      </p>
      {pickedGuestId && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-md bg-blue-50 dark:bg-blue-950 px-3 py-2 text-sm text-blue-800 dark:text-blue-300">
          <span>
            Moving <span className="font-medium">{guestName(pickedGuestId)}</span> — choose a table.
          </span>
          <button type="button" onClick={() => setPickedGuestId(null)} className="shrink-0 underline hover:no-underline">
            Cancel
          </button>
        </div>
      )}
      {unassignedGuestIds.length > 0 && (
        <div className="mb-4 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3">
          <p className="mb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">Unassigned — drag onto a table</p>
          <div className="flex flex-wrap gap-1.5">
            {unassignedGuestIds.map((id) =>
              <GuestChip
                key={id}
                guestId={id}
                name={guestName(id)}
                baseClass="rounded-full border border-dashed border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-2 py-1 text-xs"
                canEdit={canEditThisVersion}
                picked={pickedGuestId === id}
                moving={movingIds.has(id)}
                handlers={chipHandlers}
              />
            )}
          </div>
        </div>
      )}
      {/* FR-6.1: same "separate prominent area" treatment as the list view -- a Needs
          Reassignment guest is pulled out of their (no-longer-valid) table box entirely rather
          than shown there with a badge, so the floor plan never implies a placement that's no
          longer rule-compliant. */}
      {needsReassignmentGuests.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/40 dark:bg-amber-950/40 p-3">
          <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">Needs reassignment — drag onto a table</p>
          <div className="flex flex-wrap gap-1.5">
            {needsReassignmentGuests.map((g) =>
              <GuestChip
                key={g.guestId}
                guestId={g.guestId}
                name={g.guestName}
                baseClass="rounded-full border border-dashed border-amber-300 dark:border-amber-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs text-amber-800 dark:text-amber-300"
                title={`Currently at ${g.tableLabel}, which no longer fits a hard rule for them`}
                canEdit={canEditThisVersion}
                picked={pickedGuestId === g.guestId}
                moving={movingIds.has(g.guestId)}
                handlers={chipHandlers}
              />
            )}
          </div>
        </div>
      )}
      <div
        style={{ width: "100%", height, maxWidth: width }}
        className="relative overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900"
      >
        {tables.map((t) => {
          const entry = grouped.get(t.id);
          const tableGuests = entry?.guests ?? [];
          const isTarget = pickedGuestId !== null && canEditThisVersion;
          return (
            <div
              key={t.id}
              data-table-id={t.id}
              onDragOver={(e) => {
                if (!canEditThisVersion) return;
                e.preventDefault();
                setDragOverTableId(t.id);
              }}
              onDragLeave={() => setDragOverTableId((cur) => (cur === t.id ? null : cur))}
              onDrop={(e) => onTableDrop(e, t.id)}
              // TS-90: while a guest is picked up, every table is a place to put them -- by tap,
              // click, or keyboard (Tab to it, then Enter/Space).
              onClick={isTarget ? () => void moveTo(pickedGuestId, t.id) : undefined}
              onKeyDown={
                isTarget
                  ? (e) => {
                      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                      e.preventDefault();
                      void moveTo(pickedGuestId, t.id);
                    }
                  : undefined
              }
              {...(isTarget
                ? { role: "button", tabIndex: 0, "aria-label": `Move ${guestName(pickedGuestId)} to ${t.label}` }
                : {})}
              style={{
                left: t.positionX ?? 40,
                top: t.positionY ?? 40,
                width: PLAN_BOX_WIDTH,
                height: PLAN_BOX_HEIGHT,
              }}
              className={`absolute flex flex-col overflow-hidden rounded-md border-2 bg-white dark:bg-neutral-900 p-2 text-xs shadow-sm ${
                isTarget ? "cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500" : ""
              } ${
                dragOverTableId === t.id ? "border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-950" : "border-neutral-300 dark:border-neutral-600"
              }`}
            >
              <p className="mb-1 truncate font-medium" title={t.label}>
                {t.label}
              </p>
              <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
                {tableGuests.length === 0 && <span className="text-neutral-400 dark:text-neutral-500">Empty</span>}
                {tableGuests.map((g) =>
                  <GuestChip
                key={g.guestId}
                guestId={g.guestId}
                name={g.guestName}
                baseClass="truncate rounded px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                canEdit={canEditThisVersion}
                picked={pickedGuestId === g.guestId}
                moving={movingIds.has(g.guestId)}
                handlers={chipHandlers}
              />
                )}
              </div>
            </div>
          );
        })}
        {dropFeedback &&
          (() => {
            const droppedTable = tables.find((t) => t.id === dropFeedback.tableId);
            if (!droppedTable) return null;
            // Rendered as a sibling of the table boxes (not nested inside one) so it isn't
            // clipped by a table box's own `overflow-hidden` -- positioned just below the table
            // that was dropped onto, right where the user was already looking.
            return (
              <div
                role="alert"
                style={{
                  left: droppedTable.positionX ?? 40,
                  top: (droppedTable.positionY ?? 40) + PLAN_BOX_HEIGHT + 4,
                  width: PLAN_BOX_WIDTH,
                }}
                className={`absolute z-10 rounded-md border p-2 text-xs shadow-lg ${
                  dropFeedback.kind === "error"
                    ? "border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-300"
                    : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span>{dropFeedback.message}</span>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => setDropFeedback(null)}
                    className="shrink-0 leading-none opacity-60 hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })()}
      </div>
      {/* TS-90: the label that follows a finger/pen drag. pointer-events-none so it never sits
          between the finger and the table box elementFromPoint needs to find. */}
      {touchDrag && (
        <div
          aria-hidden="true"
          style={{ left: touchDrag.x, top: touchDrag.y }}
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-[140%] rounded-full bg-blue-600 px-3 py-1 text-xs font-medium text-white shadow-lg"
        >
          {guestName(touchDrag.guestId)}
        </div>
      )}
    </div>
  );
}

interface GuestChipHandlers {
  onDragStart: (e: React.DragEvent<HTMLSpanElement>, guestId: string) => void;
  onPointerDown: (e: React.PointerEvent<HTMLSpanElement>, guestId: string) => void;
  onPointerMove: (e: React.PointerEvent<HTMLSpanElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLSpanElement>) => void;
  onPointerCancel: () => void;
  onClick: (e: React.MouseEvent, guestId: string) => void;
  onKeyDown: (e: React.KeyboardEvent, guestId: string) => void;
}

// TS-90: one guest on the floor plan -- a native drag source for a mouse, a pointer-drag source for
// a finger or pen, and (when editable) a button that picks the guest up for keyboard/tap placing.
function GuestChip({
  guestId,
  name,
  baseClass,
  title,
  canEdit,
  picked,
  moving,
  handlers,
}: {
  guestId: string;
  name: string;
  baseClass: string;
  title?: string;
  canEdit: boolean;
  picked: boolean;
  moving: boolean;
  handlers: GuestChipHandlers;
}) {
  return (
    <span
      data-guest-id={guestId}
      draggable={canEdit}
      onDragStart={(e) => handlers.onDragStart(e, guestId)}
      onPointerDown={(e) => handlers.onPointerDown(e, guestId)}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onClick={(e) => handlers.onClick(e, guestId)}
      onKeyDown={(e) => handlers.onKeyDown(e, guestId)}
      {...(canEdit
        ? {
            role: "button",
            tabIndex: 0,
            "aria-pressed": picked,
            "aria-label": picked ? `${name} — picked up, choose a table` : `Move ${name}`,
          }
        : {})}
      title={title ?? name}
      // touch-none: a finger on a chip drags the guest instead of scrolling the page. Scrolling
      // still works from anywhere else on the plan.
      className={`${baseClass} ${
        canEdit
          ? `cursor-grab touch-none select-none active:cursor-grabbing focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 ${
              picked ? "ring-2 ring-blue-500" : ""
            }`
          : ""
      } ${moving ? "opacity-50" : ""}`}
    >
      {name}
    </span>
  );
}
