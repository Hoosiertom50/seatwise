"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { GuestDTO, PlanVersionDTO, PlanVersionDetailDTO } from "@seatwise/shared";

export function PlanTab({ weddingId, guests }: { weddingId: string; guests: GuestDTO[] }) {
  const [versions, setVersions] = useState<PlanVersionDTO[]>([]);
  const [detail, setDetail] = useState<PlanVersionDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    loadVersions()
      .catch(() => setError("Couldn't load seating plans."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId]);

  async function onGenerate() {
    setError(null);
    setConflicts([]);
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
    const d = await api.get<{ planVersion: PlanVersionDetailDTO }>(
      `/api/v1/weddings/${weddingId}/plan-versions/${id}`
    );
    setDetail(d.planVersion);
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading seating plans...</p>;

  const grouped = new Map<string, { tableLabel: string; guests: string[] }>();
  if (detail) {
    for (const a of detail.assignments) {
      if (!grouped.has(a.tableId)) grouped.set(a.tableId, { tableLabel: a.tableLabel, guests: [] });
      grouped.get(a.tableId)!.guests.push(a.guestName);
    }
  }

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
                v{v.versionNumber} — {v.isComplete ? "complete" : "incomplete"} (
                {new Date(v.createdAt).toLocaleString()})
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
          <div className="mb-6 flex items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                detail.isComplete ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
              }`}
            >
              Version {detail.versionNumber} — {detail.isComplete ? "complete" : "incomplete"}
            </span>
            <span className="text-sm text-neutral-500">
              {detail.assignedGuestCount} seated, {detail.unassignedGuestCount} unassigned
            </span>
          </div>

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

          {detail.unassignedGuestIds.length > 0 && (
            <div className="mb-6 rounded-lg border border-neutral-200 p-4">
              <p className="mb-2 text-sm font-medium">Unassigned guests</p>
              <p className="text-sm text-neutral-600">
                {detail.unassignedGuestIds.map(guestName).join(", ")}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {[...grouped.entries()].map(([tableId, t]) => (
              <div key={tableId} className="rounded-lg border border-neutral-200 px-4 py-3">
                <p className="font-medium">{t.tableLabel}</p>
                <p className="text-sm text-neutral-600">{t.guests.join(", ")}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
