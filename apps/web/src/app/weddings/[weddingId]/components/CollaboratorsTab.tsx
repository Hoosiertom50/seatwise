"use client";

import { useEffect, useState } from "react";
import { api, ApiError, apiErrorMessage } from "@/lib/api-client";
import type {
  CollaboratorDTO,
  CollaboratorPermission,
  CollaboratorRole,
  WeddingDTO,
  WeddingInviteDTO,
} from "@seatwise/shared";

const LEVELS: { value: CollaboratorPermission; label: string; hint: string }[] = [
  { value: "VIEW", label: "View", hint: "Can see everything, can't change anything" },
  { value: "COMMENT", label: "Comment", hint: "View, plus can leave and resolve their own comments" },
  { value: "EDIT", label: "Edit", hint: "Full access — guests, tables, rules, plan, day-of mode" },
];

const ROLES: { value: CollaboratorRole; label: string; hint: string }[] = [
  { value: "COLLABORATOR", label: "Collaborator", hint: "A helper — planner, family member, friend" },
  { value: "COUPLE", label: "Couple", hint: "One of the couple — can approve a plan (FR-6.4) at Comment/Edit" },
];

function roleLabel(role: CollaboratorRole) {
  return role === "COUPLE" ? "Couple" : "Collaborator";
}

function inviteStatusLabel(status: WeddingInviteDTO["status"]) {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "ACCEPTED":
      return "Accepted";
    case "REVOKED":
      return "Revoked";
    case "EXPIRED":
      return "Expired";
    default:
      return status;
  }
}

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
  const [invites, setInvites] = useState<WeddingInviteDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<CollaboratorPermission>("VIEW");
  const [role, setRole] = useState<CollaboratorRole>("COLLABORATOR");
  const [adding, setAdding] = useState(false);
  const [inviteSent, setInviteSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  // The wedding's own name (e.g. "Alex & Jordan's Wedding") -- previously only settable at
  // creation, with no way to fix a typo afterward even though the API already supported it. Same
  // local-input-then-save-on-blur pattern as the fields below.
  const [weddingName, setWeddingName] = useState(wedding?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  // FR-1.3a: this wedding's own names for its two sides -- edited here, then PATCHed as a pure
  // label rename. Local input state so typing doesn't PATCH on every keystroke; saved on blur.
  const [sideLabel1, setSideLabel1] = useState(wedding?.sideLabel1 ?? "Bride");
  const [sideLabel2, setSideLabel2] = useState(wedding?.sideLabel2 ?? "Groom");
  const [savingLabels, setSavingLabels] = useState(false);
  // FR-1.3: the wedding's optional free-text note -- same local-input-then-save-on-blur pattern
  // as the side labels above.
  const [note, setNote] = useState(wedding?.note ?? "");
  const [savingNote, setSavingNote] = useState(false);
  // TS-17 (FR-12.2): the planner-configured RSVP cutoff -- same local-input-then-save-on-blur
  // pattern as the note/side labels above. Empty string means no cutoff at all.
  const [rsvpCutoffDate, setRsvpCutoffDate] = useState(wedding?.rsvpCutoffDate ?? "");
  const [savingRsvpCutoff, setSavingRsvpCutoff] = useState(false);

  useEffect(() => {
    api
      .get<{ collaborators: CollaboratorDTO[] }>(`/api/v1/weddings/${weddingId}/collaborators`)
      .then((res) => setCollaborators(res.collaborators))
      .catch(() => setError("Couldn't load collaborators."))
      .finally(() => setLoading(false));
  }, [weddingId]);

  // FR-1.4a: pending/expired/revoked invites, shown to the owner only (same audience as managing
  // collaborators directly) so they can see what's outstanding, resend, or revoke. Always
  // re-fetches the full list after a mutation (send/revoke) rather than patching local state --
  // this initial load and a just-sent invite can otherwise race (a slow initial GET resolving
  // *after* onAdd's own update would silently stomp the newly created invite back out of view).
  function refreshInvites() {
    if (!isOwner) return;
    return api
      .get<{ invites: WeddingInviteDTO[] }>(`/api/v1/weddings/${weddingId}/invites`)
      .then((res) => setInvites(res.invites))
      .catch(() => {
        /* non-critical -- the collaborator list above already loaded */
      });
  }

  useEffect(() => {
    refreshInvites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId, isOwner]);

  useEffect(() => {
    if (wedding) {
      setWeddingName(wedding.name);
      setSideLabel1(wedding.sideLabel1);
      setSideLabel2(wedding.sideLabel2);
      setNote(wedding.note ?? "");
      setRsvpCutoffDate(wedding.rsvpCutoffDate ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wedding?.id]);

  // The wedding's name is required (min length 1) server-side -- an emptied-out field just
  // reverts to the last saved name on blur rather than being sent.
  async function onSaveName() {
    if (!wedding) return;
    const trimmed = weddingName.trim();
    if (trimmed === wedding.name) return;
    if (trimmed === "") {
      setError("Wedding name can't be blank.");
      setWeddingName(wedding.name);
      return;
    }
    setSavingName(true);
    setError(null);
    try {
      const { wedding: updated } = await api.patch<{ wedding: WeddingDTO }>(
        `/api/v1/weddings/${weddingId}`,
        { name: trimmed }
      );
      setWedding(updated);
      setWeddingName(updated.name);
    } catch (err) {
      setError(apiErrorMessage(err, ["name"], "Couldn't save the wedding name."));
      setWeddingName(wedding.name);
    } finally {
      setSavingName(false);
    }
  }

  async function onSaveSideLabels() {
    if (!wedding) return;
    const label1 = sideLabel1.trim() || "Bride";
    const label2 = sideLabel2.trim() || "Groom";
    if (label1 === wedding.sideLabel1 && label2 === wedding.sideLabel2) return;
    setSavingLabels(true);
    setError(null);
    try {
      const { wedding: updated } = await api.patch<{ wedding: WeddingDTO }>(
        `/api/v1/weddings/${weddingId}`,
        { sideLabel1: label1, sideLabel2: label2 }
      );
      setWedding(updated);
      setSideLabel1(updated.sideLabel1);
      setSideLabel2(updated.sideLabel2);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the side labels.");
      setSideLabel1(wedding.sideLabel1);
      setSideLabel2(wedding.sideLabel2);
    } finally {
      setSavingLabels(false);
    }
  }

  // FR-1.3: the wedding's optional note -- same save-on-blur pattern as the side labels above.
  async function onSaveNote() {
    if (!wedding) return;
    const trimmed = note.trim();
    if (trimmed === (wedding.note ?? "")) return;
    setSavingNote(true);
    setError(null);
    try {
      const { wedding: updated } = await api.patch<{ wedding: WeddingDTO }>(
        `/api/v1/weddings/${weddingId}`,
        { note: trimmed || null }
      );
      setWedding(updated);
      setNote(updated.note ?? "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the note.");
      setNote(wedding.note ?? "");
    } finally {
      setSavingNote(false);
    }
  }

  // FR-1.4/FR-1.4a: sends a real invite (token, pending, no guest data) rather than granting
  // access immediately -- the person needs to accept it, signed in with this exact address.
  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInviteSent(null);
    setAdding(true);
    try {
      await api.post<{ invite: WeddingInviteDTO }>(`/api/v1/weddings/${weddingId}/invites`, {
        email,
        permissionLevel: level,
        role,
      });
      await refreshInvites();
      setInviteSent(`Invite sent to ${email}.`);
      setEmail("");
      setLevel("VIEW");
      setRole("COLLABORATOR");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that invite.");
    } finally {
      setAdding(false);
    }
  }

  async function onRevokeInvite(id: string) {
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/invites/${id}`);
      await refreshInvites();
    } catch {
      setError("Couldn't revoke that invite.");
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

  async function onChangeRole(id: string, newRole: CollaboratorRole) {
    const prev = collaborators;
    setCollaborators(collaborators.map((c) => (c.id === id ? { ...c, role: newRole } : c)));
    try {
      await api.patch(`/api/v1/weddings/${weddingId}/collaborators/${id}`, { role: newRole });
    } catch {
      setCollaborators(prev);
      setError("Couldn't change that collaborator's role.");
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

  // FR-12.2: the RSVP cutoff -- same save-on-blur pattern as the note above. An empty input
  // clears it back to null (no cutoff at all), matching the FR's "or none" language.
  async function onSaveRsvpCutoff() {
    if (!wedding) return;
    const trimmed = rsvpCutoffDate.trim();
    if (trimmed === (wedding.rsvpCutoffDate ?? "")) return;
    setSavingRsvpCutoff(true);
    setError(null);
    try {
      const { wedding: updated } = await api.patch<{ wedding: WeddingDTO }>(
        `/api/v1/weddings/${weddingId}`,
        { rsvpCutoffDate: trimmed || null }
      );
      setWedding(updated);
      setRsvpCutoffDate(updated.rsvpCutoffDate ?? "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the RSVP cutoff.");
      setRsvpCutoffDate(wedding.rsvpCutoffDate ?? "");
    } finally {
      setSavingRsvpCutoff(false);
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

  if (loading) return <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading collaborators...</p>;

  return (
    <div>
      {isOwner && (
        <>
          <h2 className="mb-3 text-lg font-medium">Invite a collaborator</h2>
          <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
            We&apos;ll email them an invite link. It carries no guest data — they&apos;ll need to
            accept it while signed in (or after creating an account) with this exact address.
          </p>
          <form
            onSubmit={onAdd}
            className="mb-3 grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 sm:grid-cols-3"
          >
            <div className="sm:col-span-3">
              <label htmlFor="collab-email" className="mb-1 block text-sm font-medium">
                Email address
              </label>
              <input
                id="collab-email"
                type="email"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                required
              />
            </div>
            <div>
              <label htmlFor="collab-role" className="mb-1 block text-sm font-medium">
                Role
              </label>
              <select
                id="collab-role"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={role}
                onChange={(e) => setRole(e.target.value as CollaboratorRole)}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="collab-level" className="mb-1 block text-sm font-medium">
                Access level
              </label>
              <select
                id="collab-level"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
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
              className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50 sm:col-span-3"
            >
              {adding ? "Sending invite..." : "Send invite"}
            </button>
          </form>
          {inviteSent && <p className="mb-8 text-sm text-green-700 dark:text-green-400">{inviteSent}</p>}

          {invites.filter((i) => i.status === "PENDING" || i.status === "EXPIRED").length > 0 && (
            <div className="mb-8">
              <h3 className="mb-2 text-sm font-medium">Pending invites</h3>
              <ul className="flex flex-col gap-2">
                {invites
                  .filter((i) => i.status === "PENDING" || i.status === "EXPIRED")
                  .map((i) => (
                    <li
                      key={i.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3"
                    >
                      <div>
                        <p className="font-medium">{i.email}</p>
                        <p className="text-sm text-neutral-500 dark:text-neutral-400">
                          {roleLabel(i.role)} · {LEVELS.find((l) => l.value === i.permissionLevel)?.label} ·{" "}
                          <span className={i.status === "EXPIRED" ? "text-amber-700 dark:text-amber-400" : "text-neutral-500 dark:text-neutral-400"}>
                            {inviteStatusLabel(i.status)}
                          </span>
                        </p>
                      </div>
                      <button
                        onClick={() => onRevokeInvite(i.id)}
                        className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {wedding && (
            <label className="mb-8 flex items-center gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3 text-sm">
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

          {wedding && (
            <div className="mb-8 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
              <h3 className="mb-1 text-sm font-medium">Wedding name</h3>
              <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
                Shown at the top of every tab for this wedding — fix a typo here any time.
              </p>
              <input
                id="wedding-name"
                aria-label="Wedding name"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm disabled:opacity-50"
                value={weddingName}
                onChange={(e) => setWeddingName(e.target.value)}
                onBlur={onSaveName}
                maxLength={200}
                disabled={savingName}
              />
            </div>
          )}

          {wedding && (
            <div className="mb-8 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
              <h3 className="mb-1 text-sm font-medium">Side labels</h3>
              <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
                Name this wedding&apos;s two sides — used anywhere a guest&apos;s side is shown or
                set. Renaming never touches any guest, rule, or seat assignment; it&apos;s just a
                label.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="side-label-1" className="mb-1 block text-sm font-medium">
                    Side 1
                  </label>
                  <input
                    id="side-label-1"
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                    value={sideLabel1}
                    onChange={(e) => setSideLabel1(e.target.value)}
                    onBlur={onSaveSideLabels}
                    maxLength={40}
                    disabled={savingLabels}
                  />
                </div>
                <div>
                  <label htmlFor="side-label-2" className="mb-1 block text-sm font-medium">
                    Side 2
                  </label>
                  <input
                    id="side-label-2"
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                    value={sideLabel2}
                    onChange={(e) => setSideLabel2(e.target.value)}
                    onBlur={onSaveSideLabels}
                    maxLength={40}
                    disabled={savingLabels}
                  />
                </div>
              </div>
            </div>
          )}

          {wedding && (
            <div className="mb-8 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
              <h3 className="mb-1 text-sm font-medium">Note</h3>
              <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
                An optional free-text note about this wedding — owner-only, same as the settings
                above.
              </p>
              <textarea
                id="wedding-note"
                aria-label="Wedding note"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm disabled:opacity-50"
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onBlur={onSaveNote}
                disabled={savingNote}
                placeholder="Nothing noted yet"
              />
            </div>
          )}

          {wedding && (
            <div className="mb-8 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
              <h3 className="mb-1 text-sm font-medium">RSVP cutoff</h3>
              <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
                After this date, a guest&apos;s own RSVP link becomes read-only — they can still
                see what they submitted, but can no longer change it. Leave blank for no cutoff.
              </p>
              <input
                id="rsvp-cutoff-date"
                aria-label="RSVP cutoff date"
                type="date"
                className="w-full max-w-xs rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm disabled:opacity-50"
                value={rsvpCutoffDate}
                onChange={(e) => setRsvpCutoffDate(e.target.value)}
                onBlur={onSaveRsvpCutoff}
                disabled={savingRsvpCutoff}
              />
            </div>
          )}
        </>
      )}

      {error && <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <h2 className="mb-3 text-lg font-medium">People with access ({collaborators.length})</h2>
      {collaborators.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {isOwner ? "No collaborators yet — invite someone above." : "No other collaborators yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {collaborators.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3"
            >
              <div>
                <p className="font-medium">{c.userName}</p>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">{c.userEmail}</p>
              </div>
              {isOwner ? (
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Role for ${c.userName}`}
                    className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
                    value={c.role}
                    onChange={(e) => onChangeRole(c.id, e.target.value as CollaboratorRole)}
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`Access level for ${c.userName}`}
                    className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
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
                    className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-end gap-1">
                  <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-3 py-1 text-sm text-neutral-600 dark:text-neutral-300">
                    {LEVELS.find((l) => l.value === c.permissionLevel)?.label}
                  </span>
                  <span className="text-xs text-neutral-400 dark:text-neutral-500">{roleLabel(c.role)}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
