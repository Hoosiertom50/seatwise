"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { RULE_WEIGHT_CONFIG } from "@seatwise/shared";
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
  unchanged: "bg-neutral-100 text-neutral-600",
  moved: "bg-blue-50 text-blue-700",
  added: "bg-green-50 text-green-700",
  removed: "bg-red-50 text-red-700",
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
  DRAFT: "bg-neutral-100 text-neutral-700",
  IN_REVIEW: "bg-blue-50 text-blue-700",
  APPROVED: "bg-green-50 text-green-700",
};

export function PlanTab({
  weddingId,
  guests,
  canEdit,
}: {
  weddingId: string;
  guests: GuestDTO[];
  canEdit: boolean;
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
  const [movingGuestId, setMovingGuestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moveWarnings, setMoveWarnings] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [restorePreview, setRestorePreview] = useState<RestorePreviewDTO | null>(null);
  const [previewingRestore, setPreviewingRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelInput, setLabelInput] = useState("");
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
    const busy = movingGuestId !== null || undoRedoBusy || statusUpdating || savingLabel || restoring || generating;
    if (busy) return;
    const interval = setInterval(async () => {
      try {
        const res = await api.get<{ planVersion: PlanVersionDetailDTO }>(
          `/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}`
        );
        setDetail((cur) => {
          if (!cur || cur.id !== planVersionId || cur.revision === res.planVersion.revision) return cur;
          return res.planVersion;
        });
        setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
      } catch {
        // Best-effort background sync -- a transient failure here isn't worth surfacing as an
        // error; the next tick tries again.
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    detail?.id,
    detail?.isCurrent,
    weddingId,
    movingGuestId,
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
    const d = await api.get<{ planVersion: PlanVersionDetailDTO }>(
      `/api/v1/weddings/${weddingId}/plan-versions/${id}`
    );
    setDetail(d.planVersion);
  }

  async function onMoveGuest(guestId: string, tableId: string) {
    if (!detail || !tableId) return;
    setError(null);
    setMoveWarnings([]);
    setMovingGuestId(guestId);
    const priorTableId = detail.assignments.find((a) => a.guestId === guestId)?.tableId ?? null;
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/assignments`,
        { guestId, tableId, expectedRevision: detail.revision }
      );
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
    } catch (err) {
      // FR-7.7: this plan changed under us -- show the fresh state instead of leaving the view
      // stale, and don't record an undo entry for a move that never actually applied.
      const fresh = conflictPlanVersion(err);
      if (fresh) {
        setDetail(fresh);
        setVersions((vs) => vs.map((v) => (v.id === fresh.id ? fresh : v)));
      }
      setError(err instanceof ApiError ? err.message : "Couldn't move that guest.");
    } finally {
      setMovingGuestId(null);
    }
  }

  // FR-7.5: undo and redo are each "replay this one guest's move-or-unassign action" -- they
  // never reverse another user's later saved change. Before replaying, re-fetch the plan and
  // check the guest is still exactly where this action last left them; if anyone (this user via
  // another tab, or a collaborator) has since moved them again, the stale entry is dropped
  // instead of blindly overwriting that newer change, and the current state is shown instead.
  async function onUndo() {
    if (undoStack.length === 0 || !detail || undoRedoBusy) return;
    const entry = undoStack[undoStack.length - 1];
    setError(null);
    setUndoRedoBusy(true);
    try {
      const fresh = await api.get<{ planVersion: PlanVersionDetailDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}`
      );
      const currentTableId = fresh.planVersion.assignments.find((a) => a.guestId === entry.guestId)?.tableId ?? null;
      if (currentTableId !== entry.toTableId) {
        setDetail(fresh.planVersion);
        setUndoStack((s) => s.slice(0, -1));
        setError(
          `Can't undo that — ${guestName(entry.guestId)}'s seat has changed since then (possibly by another collaborator).`
        );
        return;
      }
      const res = await api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/assignments`,
        { guestId: entry.guestId, tableId: entry.priorTableId }
      );
      setDetail(res.planVersion);
      setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
      setMoveWarnings(res.warnings);
      setUndoStack((s) => s.slice(0, -1));
      setRedoStack((r) => [...r, entry]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't undo that move.");
    } finally {
      setUndoRedoBusy(false);
    }
  }

  async function onRedo() {
    if (redoStack.length === 0 || !detail || undoRedoBusy) return;
    const entry = redoStack[redoStack.length - 1];
    setError(null);
    setUndoRedoBusy(true);
    try {
      const fresh = await api.get<{ planVersion: PlanVersionDetailDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}`
      );
      const currentTableId = fresh.planVersion.assignments.find((a) => a.guestId === entry.guestId)?.tableId ?? null;
      if (currentTableId !== entry.priorTableId) {
        setDetail(fresh.planVersion);
        setRedoStack((s) => s.slice(0, -1));
        setError(
          `Can't redo that — ${guestName(entry.guestId)}'s seat has changed since then (possibly by another collaborator).`
        );
        return;
      }
      const res = await api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/assignments`,
        { guestId: entry.guestId, tableId: entry.toTableId }
      );
      setDetail(res.planVersion);
      setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
      setMoveWarnings(res.warnings);
      setRedoStack((s) => s.slice(0, -1));
      setUndoStack((u) => [...u, entry]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't redo that move.");
    } finally {
      setUndoRedoBusy(false);
    }
  }

  async function onSetStatus(newStatus: PlanVersionStatusValue) {
    if (!detail) return;
    setError(null);
    setStatusUpdating(true);
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/status`,
        { status: newStatus, expectedRevision: detail.revision }
      );
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
      const res = await api.patch<{ planVersion: PlanVersionDetailDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}`,
        { label: labelInput, expectedRevision: detail.revision }
      );
      setDetail(res.planVersion);
      setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
      setEditingLabel(false);
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

  if (loading) return <p className="text-sm text-neutral-500">Loading seating plans...</p>;

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
  const canEditThisVersion = canEdit && Boolean(detail?.isCurrent);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Seating plan</h2>
          <p className="text-sm text-neutral-500">
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
              className="min-h-11 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {generating ? "Generating..." : "Generate new plan"}
            </button>
            {/* FR-5.6: chosen upfront, before the run -- an unsuccessful run (a hard-rule
                conflict) only ever produces a conflict report either way, nothing is saved. */}
            <label className="flex items-center gap-2 text-xs text-neutral-600">
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
        <p className="mb-4 rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-600">
          You have view-only access to this wedding's seating plan.
        </p>
      )}

      {conflicts.length > 0 && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="mb-2 text-sm font-medium text-red-800">
            These rule conflicts need to be fixed first:
          </p>
          <ul className="list-inside list-disc text-sm text-red-700">
            {conflicts.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {/* FR-5.3: shown once, right after the generation run that produced it -- not persisted, so
          reloading or switching versions clears it, same as the moveWarnings/conflicts above. */}
      {scoreReport && (
        <div className="mb-6 rounded-lg border border-neutral-200 p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-neutral-800">
              Soft-preference results — weighting-configuration version {scoreReport.ruleConfigVersion},
              total score {scoreReport.totalScore}
            </p>
            <button
              onClick={() => setShowScoreDetail((s) => !s)}
              className="shrink-0 text-xs font-medium text-blue-700 hover:underline"
            >
              {showScoreDetail ? "Hide calculation" : "How is this calculated?"}
            </button>
          </div>
          {scoreReport.preferences.length > 0 && (
            <ul className="mb-2 list-inside list-disc text-sm">
              {scoreReport.preferences.map((p, i) => (
                <li key={i} className={p.satisfied ? "text-neutral-700" : "text-amber-700"}>
                  {p.guestAName} and {p.guestBName} (
                  {p.type === "PREFER_NEAR" ? "prefer near each other" : "avoid each other"}):{" "}
                  {p.satisfied ? "satisfied" : "not satisfied"}
                </li>
              ))}
            </ul>
          )}
          {scoreReport.purposeTables.length > 0 && (
            <ul className="mb-2 list-inside list-disc text-sm text-neutral-700">
              {scoreReport.purposeTables.map((t) => (
                <li key={t.tableId}>
                  &quot;{t.tableLabel}&quot; Purpose table ({t.criterionType.toLowerCase().replace("_", " ")}
                  : {t.criterionValue}): {t.matchingGuestsSeatedHere} of {t.matchingGuestsTotal} matching
                  guest(s) seated here
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-neutral-700">
            Side-Mixing ({scoreReport.sideMixing.setting}): {scoreReport.sideMixing.mixedTableCount} mixed
            table(s), {scoreReport.sideMixing.singleSideTableCount} single-side table(s)
            {scoreReport.sideMixing.singleSideOnlyViolations > 0
              ? `, ${scoreReport.sideMixing.singleSideOnlyViolations} Single-Side-Only table(s) seated both sides anyway`
              : ""}
            .
          </p>
          {showScoreDetail && (
            <pre className="mt-3 overflow-x-auto rounded bg-neutral-50 p-3 text-xs text-neutral-600">
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
            className="min-h-11 rounded-md border border-neutral-300 px-3 py-2 text-sm"
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
        <div className="mb-6 rounded-lg border border-neutral-200 p-4">
          <button
            onClick={() => {
              setShowCompare((s) => !s);
              if (!showCompare) {
                setCompareFromId(versions[1]?.id ?? "");
                setCompareToId(versions[0]?.id ?? "");
              }
            }}
            className="text-sm font-medium text-neutral-700 hover:text-neutral-900"
          >
            {showCompare ? "Hide version comparison" : "Compare two versions..."}
          </button>
          {showCompare && (
            <div className="mt-3">
              <div className="mb-3 flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="compare-from" className="mb-1 block text-xs font-medium text-neutral-500">
                    From
                  </label>
                  <select
                    id="compare-from"
                    className="min-h-11 rounded-md border border-neutral-300 px-2 py-1 text-sm"
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
                  <label htmlFor="compare-to" className="mb-1 block text-xs font-medium text-neutral-500">
                    To
                  </label>
                  <select
                    id="compare-to"
                    className="min-h-11 rounded-md border border-neutral-300 px-2 py-1 text-sm"
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
                  className="min-h-11 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
                >
                  {comparing ? "Comparing..." : "Compare"}
                </button>
              </div>
              {compareError && <p className="mb-2 text-sm text-red-600">{compareError}</p>}
              {comparison && (
                <div>
                  <p className="mb-2 text-sm text-neutral-600">
                    v{comparison.from.versionNumber}
                    {comparison.from.label ? ` (${comparison.from.label})` : ""} →{" "}
                    v{comparison.to.versionNumber}
                    {comparison.to.label ? ` (${comparison.to.label})` : ""}: {comparison.summary.movedCount}{" "}
                    moved, {comparison.summary.addedCount} added, {comparison.summary.removedCount} removed,{" "}
                    {comparison.summary.unchangedCount} unchanged
                  </p>
                  <div className="max-h-96 overflow-y-auto rounded-md border border-neutral-200">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 bg-neutral-50">
                        <tr>
                          <th className="px-3 py-2 font-medium">Guest</th>
                          <th className="px-3 py-2 font-medium">From table</th>
                          <th className="px-3 py-2 font-medium">To table</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.guests.map((g) => (
                          <tr key={g.guestId} className="border-t border-neutral-100">
                            <td className="px-3 py-1.5">{g.guestName}</td>
                            <td className="px-3 py-1.5 text-neutral-500">{g.fromTableLabel ?? "—"}</td>
                            <td className="px-3 py-1.5 text-neutral-500">{g.toTableLabel ?? "—"}</td>
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
        <p className="text-sm text-neutral-500">
          No plan generated yet — add guests and tables, then click &ldquo;Generate new
          plan&rdquo;.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                detail.isComplete ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
              }`}
            >
              Version {detail.versionNumber} — {detail.isComplete ? "complete" : "incomplete"}
            </span>
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[detail.status]}`}>
              {STATUS_LABEL[detail.status]}
            </span>
            <span className="text-sm text-neutral-500">
              {detail.assignedGuestCount} seated, {detail.unassignedGuestCount} unassigned
            </span>
            {!canEdit ? (
              detail.label && <span className="text-sm text-neutral-500">“{detail.label}”</span>
            ) : editingLabel ? (
              <span className="flex items-center gap-1">
                <input
                  autoFocus
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  placeholder="Version nickname"
                  maxLength={100}
                  className="min-h-11 rounded-md border border-neutral-300 px-2 py-1 text-sm"
                />
                <button
                  onClick={onSaveLabel}
                  disabled={savingLabel}
                  className="min-h-11 rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
                >
                  {savingLabel ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() => setEditingLabel(false)}
                  disabled={savingLabel}
                  className="min-h-11 rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => {
                  setLabelInput(detail.label ?? "");
                  setEditingLabel(true);
                }}
                className="text-sm text-neutral-500 underline hover:text-neutral-700"
              >
                {detail.label ? `“${detail.label}” (rename)` : "Add a nickname..."}
              </button>
            )}
          </div>

          {detail.status === "APPROVED" && (
            <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 p-3">
              <span className="text-sm font-medium">Export (FR-9.1/9.2/9.3):</span>
              <a
                href={`/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/export/chart`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-neutral-300 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50"
              >
                Seating chart (PDF)
              </a>
              <a
                href={`/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/export/lookup`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-neutral-300 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50"
              >
                Guest lookup list (PDF)
              </a>
              <a
                href={`/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/export/cards`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-neutral-300 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50"
              >
                Place cards (PDF)
              </a>
            </div>
          )}

          {!detail.isCurrent && (
            <div className="mb-6 rounded-lg border border-neutral-200 p-4">
              <p className="mb-2 text-sm text-neutral-500">
                This is a past version — status can only be changed on the current one. Restoring
                it (FR-9.4) makes a brand-new current version with a copy of its assignments,
                re-checked against today's guests/tables/rules — it never rewrites this version or
                anything newer.
              </p>
              {canEdit && restorePreview?.sourceVersionNumber !== detail.versionNumber && (
                <button
                  onClick={onPreviewRestore}
                  disabled={previewingRestore}
                  className="rounded-md border border-neutral-300 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                >
                  {previewingRestore ? "Checking..." : `Restore version ${detail.versionNumber}...`}
                </button>
              )}
              {canEdit && restorePreview && restorePreview.sourceVersionNumber === detail.versionNumber && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="mb-2 text-sm font-medium text-amber-800">
                    Restoring version {restorePreview.sourceVersionNumber} will create a new
                    version {restorePreview.isComplete ? "(complete)" : "(incomplete)"}: {restorePreview.keptCount}{" "}
                    guest(s) kept exactly as seated, {restorePreview.unassignedGuestIds.length} left
                    unassigned.
                  </p>
                  {restorePreview.droppedGuests.length > 0 && (
                    <ul className="mb-2 list-inside list-disc text-sm text-amber-700">
                      {restorePreview.droppedGuests.map((d, i) => (
                        <li key={i}>
                          {d.guestName} — {d.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                  {restorePreview.warnings.length > 0 && (
                    <ul className="mb-2 list-inside list-disc text-sm text-amber-700">
                      {restorePreview.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={onConfirmRestore}
                      disabled={restoring}
                      className="rounded-md bg-neutral-900 min-h-11 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
                    >
                      {restoring ? "Restoring..." : "Confirm restore"}
                    </button>
                    <button
                      onClick={() => setRestorePreview(null)}
                      disabled={restoring}
                      className="rounded-md border border-neutral-300 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {detail.isCurrent && canEdit && (
            <div className="mb-6 flex flex-wrap items-center gap-2">
              {detail.status === "DRAFT" && (
                <button
                  onClick={() => onSetStatus("IN_REVIEW")}
                  disabled={statusUpdating}
                  className="rounded-md border border-neutral-300 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                >
                  Move to review
                </button>
              )}
              {detail.status === "IN_REVIEW" && (
                <>
                  <button
                    onClick={() => onSetStatus("DRAFT")}
                    disabled={statusUpdating}
                    className="rounded-md border border-neutral-300 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Move back to draft
                  </button>
                  <button
                    onClick={() => onSetStatus("APPROVED")}
                    disabled={statusUpdating || !detail.isComplete}
                    title={!detail.isComplete ? "Every guest must be seated before a plan can be approved." : undefined}
                    className="rounded-md bg-green-700 min-h-11 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  {!detail.isComplete && (
                    <span className="text-sm text-neutral-500">
                      Seat every guest before this can be approved.
                    </span>
                  )}
                </>
              )}
              {detail.status === "APPROVED" && (
                <button
                  onClick={() => onSetStatus("IN_REVIEW")}
                  disabled={statusUpdating}
                  className="rounded-md border border-neutral-300 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                >
                  Reopen for review
                </button>
              )}
            </div>
          )}

          {detail.status === "APPROVED" && detail.modifiedSinceApproval.active && (
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-800">
                Modified since approval
              </p>
              <p className="text-sm text-amber-700">
                First change {new Date(detail.modifiedSinceApproval.firstModifiedAt!).toLocaleString()},
                latest {new Date(detail.modifiedSinceApproval.latestModifiedAt!).toLocaleString()}.
                Approval doesn&apos;t lock anything — this plan is still Approved, but review what
                changed.
              </p>
            </div>
          )}

          {detail.warnings.length > 0 && (
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="mb-2 text-sm font-medium text-amber-800">Notes on this plan:</p>
              <ul className="list-inside list-disc text-sm text-amber-700">
                {detail.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {moveWarnings.length > 0 && (
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="mb-2 text-sm font-medium text-amber-800">
                That move was made, but note:
              </p>
              <ul className="list-inside list-disc text-sm text-amber-700">
                {moveWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {!canEditThisVersion && (
            <p className="mb-4 text-sm text-neutral-500">
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
                disabled={undoStack.length === 0 || undoRedoBusy || movingGuestId !== null}
                title={undoStack.length > 0 ? `Undo: ${undoStack[undoStack.length - 1].description}` : undefined}
                className="min-h-11 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
              >
                {undoRedoBusy ? "Working..." : "Undo"}
              </button>
              <button
                data-testid="redo-button"
                onClick={onRedo}
                disabled={redoStack.length === 0 || undoRedoBusy || movingGuestId !== null}
                title={redoStack.length > 0 ? `Redo: ${redoStack[redoStack.length - 1].description}` : undefined}
                className="min-h-11 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
              >
                Redo
              </button>
              <span className="text-xs text-neutral-500">
                Undo/redo covers this browser session's own moves only (FR-7.5) — reload or switch
                versions and use version history instead.
              </span>
            </div>
          )}

          {planView === "list" && detail.unassignedGuestIds.length > 0 && (
            <div className="mb-6 rounded-lg border border-neutral-200 p-4">
              <p className="mb-2 text-sm font-medium">Unassigned guests</p>
              <ul className="flex flex-col gap-2">
                {detail.unassignedGuestIds.map((id) => (
                  <li key={id} className="flex items-center justify-between gap-2 text-sm">
                    <span>{guestName(id)}</span>
                    {canEditThisVersion && (
                      <select
                        aria-label={`Move ${guestName(id)} to a table`}
                        className="min-h-11 rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-50"
                        value=""
                        disabled={movingGuestId === id}
                        onChange={(e) => onMoveGuest(id, e.target.value)}
                      >
                        <option value="" disabled>
                          {movingGuestId === id ? "Seating..." : "Seat at..."}
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
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50/40 p-4">
              <p className="mb-1 text-sm font-medium text-amber-800">Needs reassignment</p>
              <p className="mb-3 text-xs text-neutral-500">
                Their current table no longer fits a hard rule for them (e.g. an edited field, or a
                table setting changed) — shown here rather than under that table, since it&apos;s no
                longer a valid placement for them.
              </p>
              <ul className="flex flex-col gap-2">
                {needsReassignmentGuests.map((g) => (
                  <li key={g.guestId} className="flex items-center justify-between gap-2 text-sm">
                    <span>
                      {g.guestName}{" "}
                      <span className="text-xs text-neutral-400">(currently at {g.tableLabel})</span>
                    </span>
                    {canEditThisVersion && (
                      <select
                        aria-label={`Move ${g.guestName} to a different table`}
                        className="min-h-11 rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-50"
                        value=""
                        disabled={movingGuestId === g.guestId}
                        onChange={(e) => onMoveGuest(g.guestId, e.target.value)}
                      >
                        <option value="" disabled>
                          {movingGuestId === g.guestId ? "Moving..." : "Move to..."}
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
            <h3 className="text-sm font-medium text-neutral-700">Tables</h3>
            <div className="flex gap-1 rounded-md border border-neutral-300 p-0.5 text-sm">
              <button
                onClick={() => setPlanView("list")}
                className={`rounded px-2 py-1 ${planView === "list" ? "bg-neutral-900 text-white" : "hover:bg-neutral-50"}`}
              >
                List
              </button>
              <button
                onClick={() => setPlanView("floorplan")}
                className={`rounded px-2 py-1 ${planView === "floorplan" ? "bg-neutral-900 text-white" : "hover:bg-neutral-50"}`}
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
              movingGuestId={movingGuestId}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {[...grouped.entries()].map(([tableId, t]) => (
                <div key={tableId} className="rounded-lg border border-neutral-200 px-4 py-3">
                  <p className="mb-2 font-medium">{t.tableLabel}</p>
                  <ul className="flex flex-col gap-1.5">
                    {t.guests.map((g) => (
                      <li key={g.guestId} className="flex items-center justify-between gap-2 text-sm">
                        <span>{g.guestName}</span>
                        {canEditThisVersion && (
                          <select
                            aria-label={`Move ${g.guestName} to a different table`}
                            className="min-h-11 rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-50"
                            value=""
                            disabled={movingGuestId === g.guestId}
                            onChange={(e) => onMoveGuest(g.guestId, e.target.value)}
                          >
                            <option value="" disabled>
                              {movingGuestId === g.guestId ? "Moving..." : "Move to..."}
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
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// FR-7.1: a user with Edit permission can drag a guest from one table to another in a visual
// view. Uses the native HTML5 drag-and-drop API -- a guest chip is the drag source, a table box
// is the drop target -- and always calls the same onMoveGuest handler the list view's "Move
// to..." dropdown uses, so FR-7.2 (hard-rule blocking) and FR-7.3 (soft-rule warnings) are
// enforced identically no matter which UI made the move.
function PlanFloorPlan({
  tables,
  grouped,
  unassignedGuestIds,
  needsReassignmentGuests,
  guestName,
  onMoveGuest,
  canEditThisVersion,
  movingGuestId,
}: {
  tables: SeatingTableDTO[];
  grouped: Map<string, { tableLabel: string; guests: { guestId: string; guestName: string }[] }>;
  unassignedGuestIds: string[];
  needsReassignmentGuests: { guestId: string; guestName: string; tableId: string; tableLabel: string }[];
  guestName: (id: string) => string;
  onMoveGuest: (guestId: string, tableId: string) => void;
  canEditThisVersion: boolean;
  movingGuestId: string | null;
}) {
  const [dragOverTableId, setDragOverTableId] = useState<string | null>(null);

  function onGuestDragStart(e: React.DragEvent<HTMLSpanElement>, guestId: string) {
    if (!canEditThisVersion) return;
    e.dataTransfer.setData("text/plain", guestId);
    e.dataTransfer.effectAllowed = "move";
  }

  function onTableDrop(e: React.DragEvent<HTMLDivElement>, tableId: string) {
    e.preventDefault();
    setDragOverTableId(null);
    if (!canEditThisVersion) return;
    const guestId = e.dataTransfer.getData("text/plain");
    if (guestId) onMoveGuest(guestId, tableId);
  }

  const width = Math.max(760, ...tables.map((t) => (t.positionX ?? 40) + PLAN_BOX_WIDTH + 40));
  const height = Math.max(480, ...tables.map((t) => (t.positionY ?? 40) + PLAN_BOX_HEIGHT + 40));

  return (
    <div>
      <p className="mb-3 text-sm text-neutral-500">
        {canEditThisVersion
          ? "Drag a guest onto a different table to move them — hard rules are enforced exactly as with the dropdowns above."
          : "View-only — dragging guests between tables is turned off for your access level."}
      </p>
      {unassignedGuestIds.length > 0 && (
        <div className="mb-4 rounded-lg border border-neutral-200 p-3">
          <p className="mb-2 text-xs font-medium text-neutral-500">Unassigned — drag onto a table</p>
          <div className="flex flex-wrap gap-1.5">
            {unassignedGuestIds.map((id) => (
              <span
                key={id}
                data-guest-id={id}
                draggable={canEditThisVersion}
                onDragStart={(e) => onGuestDragStart(e, id)}
                className={`rounded-full border border-dashed border-neutral-300 bg-white px-2 py-1 text-xs ${
                  canEditThisVersion ? "cursor-grab active:cursor-grabbing" : ""
                } ${movingGuestId === id ? "opacity-50" : ""}`}
              >
                {guestName(id)}
              </span>
            ))}
          </div>
        </div>
      )}
      {/* FR-6.1: same "separate prominent area" treatment as the list view -- a Needs
          Reassignment guest is pulled out of their (no-longer-valid) table box entirely rather
          than shown there with a badge, so the floor plan never implies a placement that's no
          longer rule-compliant. */}
      {needsReassignmentGuests.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/40 p-3">
          <p className="mb-2 text-xs font-medium text-amber-800">Needs reassignment — drag onto a table</p>
          <div className="flex flex-wrap gap-1.5">
            {needsReassignmentGuests.map((g) => (
              <span
                key={g.guestId}
                data-guest-id={g.guestId}
                draggable={canEditThisVersion}
                onDragStart={(e) => onGuestDragStart(e, g.guestId)}
                title={`Currently at ${g.tableLabel}, which no longer fits a hard rule for them`}
                className={`rounded-full border border-dashed border-amber-300 bg-white px-2 py-1 text-xs text-amber-800 ${
                  canEditThisVersion ? "cursor-grab active:cursor-grabbing" : ""
                } ${movingGuestId === g.guestId ? "opacity-50" : ""}`}
              >
                {g.guestName}
              </span>
            ))}
          </div>
        </div>
      )}
      <div
        style={{ width: "100%", height, maxWidth: width }}
        className="relative overflow-auto rounded-lg border border-neutral-200 bg-neutral-50"
      >
        {tables.map((t) => {
          const entry = grouped.get(t.id);
          const tableGuests = entry?.guests ?? [];
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
              style={{
                left: t.positionX ?? 40,
                top: t.positionY ?? 40,
                width: PLAN_BOX_WIDTH,
                height: PLAN_BOX_HEIGHT,
              }}
              className={`absolute flex flex-col overflow-hidden rounded-md border-2 bg-white p-2 text-xs shadow-sm ${
                dragOverTableId === t.id ? "border-blue-500 bg-blue-50" : "border-neutral-300"
              }`}
            >
              <p className="mb-1 truncate font-medium" title={t.label}>
                {t.label}
              </p>
              <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
                {tableGuests.length === 0 && <span className="text-neutral-400">Empty</span>}
                {tableGuests.map((g) => (
                  <span
                    key={g.guestId}
                    data-guest-id={g.guestId}
                    draggable={canEditThisVersion}
                    onDragStart={(e) => onGuestDragStart(e, g.guestId)}
                    title={g.guestName}
                    className={`truncate rounded px-1.5 py-0.5 bg-neutral-100 text-neutral-900 ${
                      canEditThisVersion ? "cursor-grab active:cursor-grabbing" : ""
                    } ${movingGuestId === g.guestId ? "opacity-50" : ""}`}
                  >
                    {g.guestName}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
