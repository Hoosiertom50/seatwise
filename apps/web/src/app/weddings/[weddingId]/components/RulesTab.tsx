"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { GuestDTO, RelationshipDTO, RelationshipTypeValue } from "@seatwise/shared";

const TYPES: { value: RelationshipTypeValue; label: string; hard: boolean }[] = [
  { value: "MUST_SIT_TOGETHER", label: "Must sit together", hard: true },
  { value: "MUST_NOT_SIT_TOGETHER", label: "Must NOT sit together", hard: true },
  { value: "PREFER_NEAR", label: "Prefer near (soft)", hard: false },
  { value: "AVOID", label: "Avoid (soft)", hard: false },
];

export function RulesTab({
  weddingId,
  guests,
  canEdit,
}: {
  weddingId: string;
  guests: GuestDTO[];
  canEdit: boolean;
}) {
  const [relationships, setRelationships] = useState<RelationshipDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [guestAId, setGuestAId] = useState("");
  const [guestBId, setGuestBId] = useState("");
  const [type, setType] = useState<RelationshipTypeValue>("MUST_SIT_TOGETHER");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ relationships: RelationshipDTO[] }>(`/api/v1/weddings/${weddingId}/relationships`)
      .then((res) => setRelationships(res.relationships))
      .catch(() => setError("Couldn't load seating rules."))
      .finally(() => setLoading(false));
  }, [weddingId]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!guestAId || !guestBId) {
      setError("Pick two different guests.");
      return;
    }
    if (guestAId === guestBId) {
      setError("Pick two different guests.");
      return;
    }
    setAdding(true);
    try {
      const { relationship } = await api.post<{ relationship: RelationshipDTO }>(
        `/api/v1/weddings/${weddingId}/relationships`,
        { guestAId, guestBId, type }
      );
      setRelationships([relationship, ...relationships]);
      setGuestAId("");
      setGuestBId("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that rule.");
    } finally {
      setAdding(false);
    }
  }

  // Seating rules have no "edit" verb (only add/remove) and a duplicate/conflicting rule is
  // already rejected up front by the server -- so the one real concurrent-edit risk here is a
  // stale remove: someone else already deleted this same rule a moment ago. That surfaces as a
  // 404, which is handled as success (the rule's gone either way) with a clear explanation,
  // rather than as a generic failure that puts the row back in the list only to fail again on
  // retry.
  async function onRemove(id: string) {
    const prev = relationships;
    setRelationships(relationships.filter((r) => r.id !== id));
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/relationships/${id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError("That rule was already removed — possibly by another collaborator.");
      } else {
        setRelationships(prev);
        setError(err instanceof ApiError ? err.message : "Couldn't remove that rule.");
      }
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading seating rules...</p>;

  return (
    <div>
      {!canEdit && (
        <p className="mb-4 rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-600">
          You have view-only access to this wedding's seating rules — adding or removing rules is
          turned off.
        </p>
      )}
      {canEdit && (
        <>
      <h2 className="mb-3 text-lg font-medium">Add a seating rule</h2>
      <p className="mb-3 text-sm text-neutral-500">
        &ldquo;Must&rdquo; rules are hard rules — they can never be violated once a seating chart
        is generated. &ldquo;Prefer&rdquo; and &ldquo;avoid&rdquo; are soft preferences the
        planner will try to honor.
      </p>
      <form
        onSubmit={onAdd}
        className="mb-8 grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 p-4 sm:grid-cols-3"
      >
        <div>
          <label htmlFor="rule-guest-a" className="mb-1 block text-sm font-medium">
            Guest A
          </label>
          <select
            id="rule-guest-a"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={guestAId}
            onChange={(e) => setGuestAId(e.target.value)}
            required
          >
            <option value="">Select a guest</option>
            {guests.map((g) => (
              <option key={g.id} value={g.id}>
                {g.firstName} {g.lastName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rule-guest-b" className="mb-1 block text-sm font-medium">
            Guest B
          </label>
          <select
            id="rule-guest-b"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={guestBId}
            onChange={(e) => setGuestBId(e.target.value)}
            required
          >
            <option value="">Select a guest</option>
            {guests.map((g) => (
              <option key={g.id} value={g.id}>
                {g.firstName} {g.lastName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rule-type" className="mb-1 block text-sm font-medium">
            Rule
          </label>
          <select
            id="rule-type"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={type}
            onChange={(e) => setType(e.target.value as RelationshipTypeValue)}
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={adding || guests.length < 2}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 sm:col-span-3"
        >
          {adding ? "Adding..." : "Add rule"}
        </button>
      </form>

      {guests.length < 2 && (
        <p className="mb-4 text-sm text-neutral-500">Add at least two guests first.</p>
      )}
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
        </>
      )}

      <h2 className="mb-3 text-lg font-medium">Rules ({relationships.length})</h2>
      {relationships.length === 0 ? (
        <p className="text-sm text-neutral-500">No seating rules yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {relationships.map((r) => {
            const meta = TYPES.find((t) => t.value === r.type)!;
            return (
              <li
                key={r.id}
                className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3"
              >
                <div>
                  <p className="font-medium">
                    {r.guestAName} &amp; {r.guestBName}
                  </p>
                  <p className="text-sm text-neutral-500">
                    <span className={meta.hard ? "font-medium text-red-700" : ""}>
                      {meta.label}
                    </span>
                  </p>
                </div>
                {canEdit && (
                  <button
                    onClick={() => onRemove(r.id)}
                    className="rounded-md border border-neutral-300 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
