"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type {
  GuestDTO,
  PlanVersionDTO,
  PlanVersionDetailDTO,
  PlanVersionStatusValue,
  SeatingTableDTO,
} from "@seatwise/shared";

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

export function PlanTab({ weddingId, guests }: { weddingId: string; guests: GuestDTO[] }) {
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

  if (loading) return <p className="text-sm text-neutral-500">Loading seating plans...</p>;

  const grouped = new Map<
    string,
    { tableLabel: string; guests: { guestId: string; guestName: string }[] }
  >();
  if (detail) {
    for (const a of detail.assignments) {
      if (!grouped.has(a.tableId)) grouped.set(a.tableId, { tableLabel: a.tableLabel, guests: [] });
      grouped.get(a.tableId)!.guests.push({ guestId: a.guestId, guestName: a.guestName });
    }
  }
  const canEdit = Boolean(detail?.isCurrent);

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
        <button
          onClick={onGenerate}
          disabled={generating}
          className="shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {generating ? "Generating..." : "Generate new plan"}
        </button>
      </div>

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
          <label className="mb-1 block text-sm font-medium">Version</label>
          <select
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={detail?.id ?? ""}
            onChange={(e) => onSelectVersion(e.target.value)}
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.versionNumber} — {v.isComplete ? "complete" : "incomplete"},{" "}
                {STATUS_LABEL[v.status]} ({new Date(v.createdAt).toLocaleString()})
              </option>
            ))}
          </select>
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
          </div>

          {!detail.isCurrent && (
            <p className="mb-4 text-sm text-neutral-500">
              This is a past version — status can only be changed on the current one.
            </p>
          )}

          {detail.isCurrent && (
            <div className="mb-6 flex flex-wrap items-center gap-2">
              {detail.status === "DRAFT" && (
                <button
                  onClick={() => onSetStatus("IN_REVIEW")}
                  disabled={statusUpdating}
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                >
                  Move to review
                </button>
              )}
              {detail.status === "IN_REVIEW" && (
                <>
                  <button
                    onClick={() => onSetStatus("DRAFT")}
                    disabled={statusUpdating}
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Move back to draft
                  </button>
                  <button
                    onClick={() => onSetStatus("APPROVED")}
                    disabled={statusUpdating || !detail.isComplete}
                    title={!detail.isComplete ? "Every guest must be seated before a plan can be approved." : undefined}
                    className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
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
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
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

          {!canEdit && (
            <p className="mb-4 text-sm text-neutral-500">
              This is a past version — guests can only be manually moved on the current one.
            </p>
          )}

          {detail.unassignedGuestIds.length > 0 && (
            <div className="mb-6 rounded-lg border border-neutral-200 p-4">
              <p className="mb-2 text-sm font-medium">Unassigned guests</p>
              <ul className="flex flex-col gap-2">
                {detail.unassignedGuestIds.map((id) => (
                  <li key={id} className="flex items-center justify-between gap-2 text-sm">
                    <span>{guestName(id)}</span>
                    {canEdit && (
                      <select
                        className="rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-50"
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

          <div className="flex flex-col gap-3">
            {[...grouped.entries()].map(([tableId, t]) => (
              <div key={tableId} className="rounded-lg border border-neutral-200 px-4 py-3">
                <p className="mb-2 font-medium">{t.tableLabel}</p>
                <ul className="flex flex-col gap-1.5">
                  {t.guests.map((g) => (
                    <li key={g.guestId} className="flex items-center justify-between gap-2 text-sm">
                      <span>{g.guestName}</span>
                      {canEdit && (
                        <select
                          className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-50"
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
        </>
      )}
    </div>
  );
}
