"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { CollaboratorDTO, CollaboratorPermission, WeddingDTO } from "@seatwise/shared";

const LEVELS: { value: CollaboratorPermission; label: string; hint: string }[] = [
  { value: "VIEW", label: "View", hint: "Can see everything, can't change anything" },
  { value: "COMMENT", label: "Comment", hint: "View, plus can leave and resolve their own comments" },
  { value: "EDIT", label: "Edit", hint: "Full access — guests, tables, rules, plan, day-of mode" },
];

// TS-13 (Collaboration & Notifications, FR-10.x): who has access to this wedding and at what
// level. Anyone with access can see this list; only the owner can invite, change a level, or
// remove someone.
export function CollaboratorsTab({
  weddingId,
  isOwner,
  wedding,
  setWedding,
}: {
  weddingId: string;
  isOwner: boolean;
  wedding: WeddingDTO | null;
  setWedding: (w: WeddingDTO) => void;
}) {
  const [collaborators, setCollaborators] = useState<CollaboratorDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<CollaboratorPermission>("VIEW");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    api
      .get<{ collaborators: CollaboratorDTO[] }>(`/api/v1/weddings/${weddingId}/collaborators`)
      .then((res) => setCollaborators(res.collaborators))
      .catch(() => setError("Couldn't load collaborators."))
      .finally(() => setLoading(false));
  }, [weddingId]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      const { collaborator } = await api.post<{ collaborator: CollaboratorDTO }>(
        `/api/v1/weddings/${weddingId}/collaborators`,
        { email, permissionLevel: level }
      );
      setCollaborators([...collaborators, collaborator]);
      setEmail("");
      setLevel("VIEW");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that collaborator.");
    } finally {
      setAdding(false);
    }
  }

  async function onChangeLevel(id: string, permissionLevel: CollaboratorPermission) {
    const prev = collaborators;
    setCollaborators(collaborators.map((c) => (c.id === id ? { ...c, permissionLevel } : c)));
    try {
      await api.patch(`/api/v1/weddings/${weddingId}/collaborators/${id}`, { permissionLevel });
    } catch {
      setCollaborators(prev);
      setError("Couldn't change that collaborator's access level.");
    }
  }

  async function onRemove(id: string) {
    const prev = collaborators;
    setCollaborators(collaborators.filter((c) => c.id !== id));
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/collaborators/${id}`);
    } catch {
      setCollaborators(prev);
      setError("Couldn't remove that collaborator.");
    }
  }

  async function onToggleEmailNotifications() {
    if (!wedding) return;
    const next = !wedding.emailNotificationsEnabled;
    setWedding({ ...wedding, emailNotificationsEnabled: next });
    setSavingSettings(true);
    try {
      await api.patch(`/api/v1/weddings/${weddingId}/notification-settings`, {
        emailNotificationsEnabled: next,
      });
    } catch {
      setWedding({ ...wedding, emailNotificationsEnabled: !next });
      setError("Couldn't update the email notification setting.");
    } finally {
      setSavingSettings(false);
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading collaborators...</p>;

  return (
    <div>
      {isOwner && (
        <>
          <h2 className="mb-3 text-lg font-medium">Invite a collaborator</h2>
          <p className="mb-3 text-sm text-neutral-500">
            They need an existing Seatwise account. Give them the access level that matches what
            they should be able to do here.
          </p>
          <form
            onSubmit={onAdd}
            className="mb-8 grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 p-4 sm:grid-cols-3"
          >
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium">Email address</label>
              <input
                type="email"
                className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Access level</label>
              <select
                className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                value={level}
                onChange={(e) => setLevel(e.target.value as CollaboratorPermission)}
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={adding}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 sm:col-span-3"
            >
              {adding ? "Inviting..." : "Invite"}
            </button>
          </form>

          {wedding && (
            <label className="mb-8 flex items-center gap-3 rounded-lg border border-neutral-200 px-4 py-3 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={wedding.emailNotificationsEnabled}
                onChange={onToggleEmailNotifications}
                disabled={savingSettings}
              />
              Also send email notifications for this wedding (in-app notifications always happen)
            </label>
          )}
        </>
      )}

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <h2 className="mb-3 text-lg font-medium">People with access ({collaborators.length})</h2>
      {collaborators.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {isOwner ? "No collaborators yet — invite someone above." : "No other collaborators yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {collaborators.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 px-4 py-3"
            >
              <div>
                <p className="font-medium">{c.userName}</p>
                <p className="text-sm text-neutral-500">{c.userEmail}</p>
              </div>
              {isOwner ? (
                <div className="flex items-center gap-2">
                  <select
                    className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                    value={c.permissionLevel}
                    onChange={(e) => onChangeLevel(c.id, e.target.value as CollaboratorPermission)}
                  >
                    {LEVELS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => onRemove(c.id)}
                    className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-red-600 hover:bg-red-50"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <span className="rounded-full bg-neutral-100 px-3 py-1 text-sm text-neutral-600">
                  {LEVELS.find((l) => l.value === c.permissionLevel)?.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
