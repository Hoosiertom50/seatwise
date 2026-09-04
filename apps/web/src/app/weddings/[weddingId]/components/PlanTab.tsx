"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type {
  GuestDTO,
  PlanVersionComparisonDTO,
  PlanVersionDTO,
  PlanVersionDetailDTO,
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
  return `v${v.versionNumber}${v.label ? ` — ${v.label}` : ""} (${new Date(v.createdAt).toLocaleDateString()})`;
}

// FR-7.1: the floor-plan boxes reuse each table's saved (positionX, positionY) from the Tables
// tab's own floor plan (FR-4.3) so both views agree on where a table sits in the room -- only its
// footprint differs here, since this view also needs room to list the guests seated at it.
const PLAN_BOX_WIDTH = 168;
const PLAN_BOX_MIN_HEIGHT = 92;

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

  const guestName = (id: string) => {
    const g = guests.find((g) => g.id === id);
    return g ? `${g.firstName} ${g.lastName}` : id;
  };

  async function loadVersions(selectId?: string) {
    const res = await api.get<{ planVersions: PlanVersionDTO[] }>(
      `/api/v1/weddings/${weddingId}/plan-versions`
    );
    setVersions(res.planVersions);
    const idToLoad = selectId ?? res.planVersions[0]?.id;
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

  async function onGenerate() {
    setError(null);
    setConflicts([]);
    setMoveWarnings([]);
    setRestorePreview(null);
    setGenerating(true);
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/generate`
      );
      await loadVersions(res.planVersion.id);
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
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/assignments`,
        { guestId, tableId }
      );
      setDetail(res.planVersion);
      setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
      setMoveWarnings(res.warnings);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't move that guest.");
    } finally {
      setMovingGuestId(null);
    }
  }

  async function onSetStatus(newStatus: PlanVersionStatusValue) {
    if (!detail) return;
    setError(null);
    setStatusUpdating(true);
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${detail.id}/status`,
        { status: newStatus }
      );
      setDetail(res.planVersion);
      setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
    } catch (err) {
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
        { label: labelInput }
      );
      setDetail(res.planVersion);
      setVersions((vs) => vs.map((v) => (v.id === res.planVersion.id ? res.planVersion : v)));
      setEditingLabel(false);
    } catch (err) {
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

  const grouped = new Map<
    string,
    { tableLabel: string; guests: { guestId: string; guestName: string; needsReassignment: boolean }[] }
  >();
  if (detail) {
    for (const a of detail.assignments) {
      if (!grouped.has(a.tableId)) grouped.set(a.tableId, { tableLabel: a.tableLabel, guests: [] });
      grouped
        .get(a.tableId)!
        .guests.push({ guestId: a.guestId, guestName: a.guestName, needsReassignment: a.needsReassignment });
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
          <button
            onClick={onGenerate}
            disabled={generating}
            className="min-h-11 shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {generating ? "Generating..." : "Generate new plan"}
          </button>
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
                        <span>
                          {g.guestName}
                          {g.needsReassignment && (
                            <span
                              className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700"
                              title="This guest's current table no longer fits a hard rule for them (e.g. an edited field, or a table setting changed) — move them to fix it."
                            >
                              needs reassignment
                            </span>
                          )}
                        </span>
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
  guestName,
  onMoveGuest,
  canEditThisVersion,
  movingGuestId,
}: {
  tables: SeatingTableDTO[];
  grouped: Map<string, { tableLabel: string; guests: { guestId: string; guestName: string; needsReassignment: boolean }[] }>;
  unassignedGuestIds: string[];
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
  const height = Math.max(480, ...tables.map((t) => (t.positionY ?? 40) + PLAN_BOX_MIN_HEIGHT + 40));

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
                minHeight: PLAN_BOX_MIN_HEIGHT,
              }}
              className={`absolute flex flex-col rounded-md border-2 bg-white p-2 text-xs shadow-sm ${
                dragOverTableId === t.id ? "border-blue-500 bg-blue-50" : "border-neutral-300"
              }`}
            >
              <p className="mb-1 truncate font-medium" title={t.label}>
                {t.label}
              </p>
              <div className="flex max-h-24 flex-col gap-1 overflow-y-auto">
                {tableGuests.length === 0 && <span className="text-neutral-400">Empty</span>}
                {tableGuests.map((g) => (
                  <span
                    key={g.guestId}
                    data-guest-id={g.guestId}
                    draggable={canEditThisVersion}
                    onDragStart={(e) => onGuestDragStart(e, g.guestId)}
                    title={g.needsReassignment ? "Needs reassignment — this table no longer fits a hard rule for them" : undefined}
                    className={`truncate rounded px-1.5 py-0.5 ${
                      g.needsReassignment ? "bg-amber-50 text-amber-700" : "bg-neutral-100"
                    } ${canEditThisVersion ? "cursor-grab active:cursor-grabbing" : ""} ${
                      movingGuestId === g.guestId ? "opacity-50" : ""
                    }`}
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
