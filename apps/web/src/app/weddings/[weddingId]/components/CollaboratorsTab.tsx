"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDeleteButton } from "@/components/ConfirmDeleteButton";
import { CommitSelect } from "@/components/CommitSelect";
import { api, ApiError, apiErrorMessage } from "@/lib/api-client";
import type {
  CollaboratorDTO,
  CollaboratorPermission,
  CollaboratorRole,
  WeddingDTO,
  WeddingInviteDTO,
} from "@seatwise/shared";
import { useUnsavedChanges, useUnsavedFields } from "@/lib/unsaved-changes";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

// TS-179: guest RSVP and vendor links someone copied while they had access aren't tied to them,
// so taking access away doesn't stop those links -- the owner's reset below does.
const LINKS_KEEP_WORKING =
  "Any guest or vendor links they copied keep working until you use Reset all guest and vendor links below.";

const LEVELS: { value: CollaboratorPermission; label: string; hint: string }[] = [
  { value: "VIEW", label: "View", hint: "Can see everything, can't change anything" },
  { value: "COMMENT", label: "Comment", hint: "View, plus can leave and resolve their own comments" },
  { value: "EDIT", label: "Edit", hint: "Full access — guests, tables, rules, plan, day-of mode" },
];

const ROLES: { value: CollaboratorRole; label: string; hint: string }[] = [
  { value: "COLLABORATOR", label: "Collaborator", hint: "A helper — planner, family member, friend" },
  { value: "COUPLE", label: "Couple", hint: "One of the couple — can approve a plan at Comment or Edit access" },
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
  currentUserId,
  wedding,
  setWedding,
}: {
  weddingId: string;
  isOwner: boolean;
  /** TS-148: so a collaborator can leave the wedding from their own row. */
  currentUserId: string | null;
  wedding: WeddingDTO | null;
  // TS-182: takes an update function too, so each save changes only its own field.
  setWedding: React.Dispatch<React.SetStateAction<WeddingDTO | null>>;
}) {
  const [collaborators, setCollaborators] = useState<CollaboratorDTO[]>([]);
  const router = useRouter();
  // TS-105: which collaborator the owner is handing the wedding to.
  const [handOffTo, setHandOffTo] = useState("");
  // TS-199: why a hand-off failed, shown under the Hand off button.
  const [handOffError, setHandOffError] = useState<string | null>(null);
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
  // TS-154 (Tom's decision #5): the wedding's date and venue could only be set when it was created.
  const [eventDate, setEventDate] = useState(wedding?.eventDate ?? "");
  const [venueName, setVenueName] = useState(wedding?.venueName ?? "");
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsSaved, setDetailsSaved] = useState(false);
  // FR-1.3a: this wedding's own names for its two sides -- edited here, then PATCHed as a pure
  // label rename. Local input state so typing doesn't PATCH on every keystroke; saved on blur.
  const [sideLabel1, setSideLabel1] = useState(wedding?.sideLabel1 ?? "Bride");
  const [sideLabel2, setSideLabel2] = useState(wedding?.sideLabel2 ?? "Groom");
  // FR-1.3: the wedding's optional free-text note -- same local-input-then-save-on-blur pattern
  // as the side labels above.
  const [note, setNote] = useState(wedding?.note ?? "");
  const [savingNote, setSavingNote] = useState(false);
  // TS-17 (FR-12.2): the planner-configured RSVP cutoff -- same local-input-then-save-on-blur
  // pattern as the note/side labels above. Empty string means no cutoff at all.
  const [rsvpCutoffDate, setRsvpCutoffDate] = useState(wedding?.rsvpCutoffDate ?? "");
  const [savingRsvpCutoff, setSavingRsvpCutoff] = useState(false);
  // TS-159: tell the page this tab has input that leaving it would lose.
  // TS-182: the settings that save when you leave the box count too while they differ from what's
  // saved (a reload or Back with a half-typed name or note used to lose it without a word). Only
  // the owner sees these boxes.
  // TS-191: the boxes that save when you leave them (name, side labels, note, RSVP cutoff) count
  // only while they are being typed in. Leaving one starts its save, so it stops counting right
  // then -- before, it counted until the save answered, and clicking another tab straight after
  // typing asked "leave and lose them?" about something that was already being saved. Date and
  // venue only save with their button, so they count while changed, until Save is pressed.
  const settingFields = useUnsavedFields();
  useEffect(() => {
    if (!isOwner) settingFields.clearAll();
  }, [isOwner, settingFields]);
  useUnsavedChanges(
    "collaborators",
    isOwner &&
      (!!email.trim() ||
        (!!wedding &&
          !savingDetails &&
          (eventDate !== (wedding.eventDate ?? "") || venueName !== (wedding.venueName ?? ""))))
  );

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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- TS-176: fills the settings form from the wedding once it has loaded.
      setWeddingName(wedding.name);
      setEventDate(wedding.eventDate ?? "");
      setVenueName(wedding.venueName ?? "");
      setSideLabel1(wedding.sideLabel1);
      setSideLabel2(wedding.sideLabel2);
      setNote(wedding.note ?? "");
      setRsvpCutoffDate(wedding.rsvpCutoffDate ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wedding?.id]);

  // TS-199: a setting that couldn't be saved (no connection, or refused as invalid) keeps what was
  // typed in its box and keeps counting as unsaved, with the error shown -- it used to be swapped
  // back for the saved value, losing the typing. Only a 409 (someone else changed the wedding)
  // puts the saved value back.
  function keepTypedUnlessConflict(err: unknown, fieldKey: string, putBack: () => void) {
    if (err instanceof ApiError && err.status === 409) {
      putBack();
      settingFields.markDirty(fieldKey, false);
    } else settingFields.markDirty(fieldKey, true);
  }

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
      // TS-182: only the field this save owns, so a slower answer can't undo another setting.
      setWedding((w) => (w ? { ...w, name: updated.name, updatedAt: updated.updatedAt } : w));
      setWeddingName(updated.name);
    } catch (err) {
      setError(apiErrorMessage(err, ["name"], "Couldn't save the wedding name."));
      keepTypedUnlessConflict(err, "setting-name", () => setWeddingName(wedding.name));
    } finally {
      setSavingName(false);
    }
  }

  // TS-154: date and venue are saved together with a Save button (a date picker fires change
  // events as you go, so saving on every change would send half-picked dates).
  async function onSaveDetails(e: React.FormEvent) {
    e.preventDefault();
    if (!wedding) return;
    setSavingDetails(true);
    setDetailsSaved(false);
    setError(null);
    try {
      const { wedding: updated } = await api.patch<{ wedding: WeddingDTO }>(`/api/v1/weddings/${weddingId}`, {
        eventDate: eventDate || null,
        venueName: venueName.trim() || null,
      });
      setWedding((w) =>
        w ? { ...w, eventDate: updated.eventDate, venueName: updated.venueName, updatedAt: updated.updatedAt } : w
      );
      setEventDate(updated.eventDate ?? "");
      setVenueName(updated.venueName ?? "");
      setDetailsSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, ["eventDate", "venueName"], "Couldn't save the date and venue."));
    } finally {
      setSavingDetails(false);
    }
  }

  // TS-137: each box saves only its own label. Saving both from either box let a slow save from
  // leaving Side 1 (carrying Side 2's old value) land after Side 2's own save and undo it, and
  // refilling both boxes from the response wiped out whatever the planner was typing in the other.
  async function onSaveSideLabel(which: 1 | 2) {
    if (!wedding) return;
    const typed = which === 1 ? sideLabel1 : sideLabel2;
    const setTyped = which === 1 ? setSideLabel1 : setSideLabel2;
    const field = which === 1 ? "sideLabel1" : "sideLabel2";
    const label = typed.trim() || (which === 1 ? "Bride" : "Groom");
    if (label === wedding[field]) {
      if (typed.trim() === "") setTyped(label);
      return;
    }
    setError(null);
    try {
      const { wedding: updated } = await api.patch<{ wedding: WeddingDTO }>(
        `/api/v1/weddings/${weddingId}`,
        { [field]: label }
      );
      setWedding((w) => (w ? { ...w, [field]: updated[field], updatedAt: updated.updatedAt } : w));
      // A blank box shows what it saved as (Bride/Groom), unless the planner has typed since.
      setTyped((current) => (current.trim() === "" ? updated[field] : current));
    } catch (err) {
      setError(apiErrorMessage(err, [], "Couldn't save the side labels."));
      keepTypedUnlessConflict(err, `setting-side-${which}`, () => setTyped(wedding[field]));
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
      setWedding((w) => (w ? { ...w, note: updated.note, updatedAt: updated.updatedAt } : w));
      setNote(updated.note ?? "");
    } catch (err) {
      setError(apiErrorMessage(err, [], "Couldn't save the note."));
      keepTypedUnlessConflict(err, "setting-note", () => setNote(wedding.note ?? ""));
    } finally {
      setSavingNote(false);
    }
  }

  // TS-105: hand the wedding off, then reload -- this page's own access level has just changed.
  async function onHandOff() {
    if (!handOffTo) return;
    setHandOffError(null);
    try {
      await api.post(`/api/v1/weddings/${weddingId}/transfer-ownership`, { collaboratorId: handOffTo });
      window.location.reload();
    } catch (err) {
      setHandOffError(apiErrorMessage(err, [], "Couldn't hand off this wedding."));
    }
  }

  // TS-161: the owner deletes the wedding for everyone, then goes back to the dashboard.
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // TS-179: the owner's "Reset all guest and vendor links" -- what happened, or why it failed.
  const [resetLinksDone, setResetLinksDone] = useState<string | null>(null);
  const [resetLinksError, setResetLinksError] = useState<string | null>(null);
  // TS-179: shown after the owner lowers someone's access (there is no confirmation for that).
  const [loweredAccessNote, setLoweredAccessNote] = useState<string | null>(null);
  async function onDeleteWedding() {
    setDeleteError(null);
    try {
      await api.delete(`/api/v1/weddings/${weddingId}`);
      router.push("/dashboard");
    } catch (err) {
      // Shown inside the delete section, next to the button the owner just used.
      setDeleteError(apiErrorMessage(err, [], "Couldn't delete this wedding."));
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
      const res = await api.post<{ invite: WeddingInviteDTO; emailed: boolean; acceptUrl?: string }>(
        `/api/v1/weddings/${weddingId}/invites`,
        { email, permissionLevel: level, role }
      );
      await refreshInvites();
      // TS-132: only say "sent" when the email really went. Otherwise hand over the link to share.
      setInviteSent(
        res.emailed
          ? `Invite sent to ${email}.`
          : `Invite created, but the email to ${email} couldn't be sent. Send them this link yourself: ${res.acceptUrl}`
      );
      setEmail("");
      setLevel("VIEW");
      setRole("COLLABORATOR");
    } catch (err) {
      setError(apiErrorMessage(err, [], "Couldn't send that invite."));
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

  // TS-179: owner only -- every guest and vendor link gets a new address; the old ones stop working.
  async function onResetLinks() {
    setResetLinksDone(null);
    setResetLinksError(null);
    try {
      const res = await api.post<{ guestLinks: number; vendorLinks: number }>(
        `/api/v1/weddings/${weddingId}/reset-links`
      );
      const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
      setResetLinksDone(
        `Done — replaced ${plural(res.guestLinks, "guest link")} and ${plural(res.vendorLinks, "vendor link")}. The old links no longer work.`
      );
    } catch (err) {
      setResetLinksError(err instanceof ApiError ? err.message : "Couldn't reset the links. Nothing was changed.");
    }
  }

  // TS-195: one person's level and role changes are saved one at a time, in the order they were
  // made, and each answer puts the saved level and role on screen. Two quick changes used to race:
  // the older answer could land last, and a failure put back a value from before the newer change.
  // What's last confirmed by the server is kept per person, so a failure goes back to that.
  const collaboratorSaves = useRef(new Map<string, Promise<unknown>>());
  const confirmedAccess = useRef(new Map<string, { permissionLevel: CollaboratorPermission; role: CollaboratorRole }>());
  type SavedAccess = { permissionLevel: CollaboratorPermission; role: CollaboratorRole };
  function saveCollaborator(id: string, change: Partial<SavedAccess>): Promise<SavedAccess> {
    const run = async () => {
      const res = await api.patch<{ collaborator?: SavedAccess }>(`/api/v1/weddings/${weddingId}/collaborators/${id}`, change);
      const saved = res.collaborator;
      if (saved) {
        confirmedAccess.current.set(id, saved);
        // Only once no newer change for this person is waiting -- that one shows its own value.
        if (collaboratorSaves.current.get(id) === next) {
          setCollaborators((cur) => cur.map((c) => (c.id === id ? { ...c, ...saved } : c)));
        }
      }
      return saved ?? (change as SavedAccess);
    };
    const next: Promise<SavedAccess> = (collaboratorSaves.current.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
    collaboratorSaves.current.set(id, next);
    return next;
  }
  function lastConfirmed(id: string): SavedAccess | undefined {
    const known = confirmedAccess.current.get(id);
    if (known) return known;
    const c = collaborators.find((x) => x.id === id);
    return c ? { permissionLevel: c.permissionLevel, role: c.role } : undefined;
  }

  async function onChangeLevel(id: string, permissionLevel: CollaboratorPermission) {
    // TS-182: on failure only this person's level goes back, on the list as it is now.
    const before = collaborators.find((c) => c.id === id);
    const confirmedBefore = lastConfirmed(id);
    if (confirmedBefore && !confirmedAccess.current.has(id)) confirmedAccess.current.set(id, confirmedBefore);
    setLoweredAccessNote(null);
    setCollaborators((cur) => cur.map((c) => (c.id === id ? { ...c, permissionLevel } : c)));
    const save = saveCollaborator(id, { permissionLevel });
    try {
      const saved = await save;
      const rank = (l: CollaboratorPermission) => LEVELS.findIndex((x) => x.value === l);
      if (before && rank(saved.permissionLevel) < rank(before.permissionLevel)) {
        setLoweredAccessNote(
          `${before.userName}'s access is now ${LEVELS[rank(saved.permissionLevel)].label}. ${LINKS_KEEP_WORKING}`
        );
      }
    } catch {
      // Put back what's saved -- unless a newer change for this person is waiting, which shows its own.
      const back = confirmedAccess.current.get(id);
      if (back && collaboratorSaves.current.get(id) === save)
        setCollaborators((cur) => cur.map((c) => (c.id === id ? { ...c, ...back } : c)));
      setError("Couldn't change that collaborator's access level.");
    }
  }

  async function onChangeRole(id: string, newRole: CollaboratorRole) {
    // TS-182: as above -- only this person's role goes back.
    const confirmedBefore = lastConfirmed(id);
    if (confirmedBefore && !confirmedAccess.current.has(id)) confirmedAccess.current.set(id, confirmedBefore);
    setCollaborators((cur) => cur.map((c) => (c.id === id ? { ...c, role: newRole } : c)));
    const save = saveCollaborator(id, { role: newRole });
    try {
      await save;
    } catch {
      const back = confirmedAccess.current.get(id);
      if (back && collaboratorSaves.current.get(id) === save)
        setCollaborators((cur) => cur.map((c) => (c.id === id ? { ...c, ...back } : c)));
      setError("Couldn't change that collaborator's role.");
    }
  }

  async function onRemove(id: string) {
    // TS-182: on failure only this person comes back, in their old place.
    const index = collaborators.findIndex((c) => c.id === id);
    const removed = collaborators[index];
    setCollaborators((cur) => cur.filter((c) => c.id !== id));
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/collaborators/${id}`);
    } catch {
      if (removed)
        setCollaborators((cur) =>
          cur.some((c) => c.id === id) ? cur : [...cur.slice(0, index), removed, ...cur.slice(index)]
        );
      setError("Couldn't remove that collaborator.");
    }
  }

  // FR-12.2: the RSVP cutoff -- same save-on-blur pattern as the note above. An empty input
  // clears it back to null (no cutoff at all), matching the FR's "or none" language.
  async function onSaveRsvpCutoff(input: HTMLInputElement) {
    // TS-175: a half-typed date reads as empty, which used to clear the cutoff. Leave it alone
    // and say so; only a box that's really empty clears it.
    if (input.validity.badInput) {
      setError("Finish typing the RSVP cutoff date (or clear the box) — it hasn't been changed.");
      return;
    }
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
      setWedding((w) => (w ? { ...w, rsvpCutoffDate: updated.rsvpCutoffDate, updatedAt: updated.updatedAt } : w));
      setRsvpCutoffDate(updated.rsvpCutoffDate ?? "");
    } catch (err) {
      setError(apiErrorMessage(err, [], "Couldn't save the RSVP cutoff."));
      keepTypedUnlessConflict(err, "setting-rsvp-cutoff", () => setRsvpCutoffDate(wedding.rsvpCutoffDate ?? ""));
    } finally {
      setSavingRsvpCutoff(false);
    }
  }

  async function onToggleEmailNotifications() {
    if (!wedding) return;
    const next = !wedding.emailNotificationsEnabled;
    // TS-182: changes (and on failure, puts back) only this one setting, on the wedding as it is
    // now -- a copy taken here used to undo a name or note saved meanwhile.
    setWedding((w) => (w ? { ...w, emailNotificationsEnabled: next } : w));
    setSavingSettings(true);
    try {
      await api.patch(`/api/v1/weddings/${weddingId}/notification-settings`, {
        emailNotificationsEnabled: next,
      });
    } catch {
      setWedding((w) => (w ? { ...w, emailNotificationsEnabled: !next } : w));
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
                maxLength={FIELD_LIMITS.email}
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
          {inviteSent && (
            <p
              role="status"
              className={`mb-8 break-all text-sm ${
                inviteSent.startsWith("Invite sent") ? "text-green-700 dark:text-green-400" : "text-amber-800 dark:text-amber-300"
              }`}
            >
              {inviteSent}
            </p>
          )}

          {invites.filter((i) => i.status === "PENDING" || i.status === "EXPIRED").length > 0 && (
            <div className="mb-8">
              <h3 className="mb-2 text-sm font-medium">Pending invites</h3>
              <ul className="flex flex-col gap-2">
                {invites
                  .filter((i) => i.status === "PENDING" || i.status === "EXPIRED")
                  .map((i) => (
                    <li
                      key={i.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3"
                    >
                      {/* TS-182: a long address wraps instead of pushing Revoke off a phone screen. */}
                      <div className="min-w-0">
                        <p className="break-all font-medium">{i.email}</p>
                        <p className="text-sm text-neutral-500 dark:text-neutral-400">
                          {roleLabel(i.role)} · {LEVELS.find((l) => l.value === i.permissionLevel)?.label} ·{" "}
                          <span className={i.status === "EXPIRED" ? "text-amber-700 dark:text-amber-400" : "text-neutral-500 dark:text-neutral-400"}>
                            {inviteStatusLabel(i.status)}
                          </span>
                        </p>
                      </div>
                      <ConfirmDeleteButton
                        id={`invite-${i.id}-revoke`}
                        label="Revoke"
                        ariaLabel={`Revoke the invite for ${i.email}`}
                        question={`Revoke the invite for ${i.email}? Their link stops working. You can send a new invite later.`}
                        confirmLabel="Yes, revoke invite"
                        onConfirm={() => onRevokeInvite(i.id)}
                      />
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
                // TS-199: saves when you leave it -- Back on the wedding page saves it instead of asking.
                data-blur-save=""
                aria-label="Wedding name"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm disabled:opacity-50"
                value={weddingName}
                onChange={(e) => {
                  setWeddingName(e.target.value);
                  settingFields.markDirty("setting-name", e.target.value.trim() !== wedding.name);
                }}
                onBlur={() => {
                  settingFields.markDirty("setting-name", false);
                  void onSaveName();
                }}
                maxLength={FIELD_LIMITS.weddingName}
                disabled={savingName}
              />
            </div>
          )}

          {wedding && (
            <form
              onSubmit={onSaveDetails}
              aria-labelledby="wedding-details-heading"
              className="mb-8 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4"
            >
              <h3 id="wedding-details-heading" className="mb-1 text-sm font-medium">
                Date and venue
              </h3>
              <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
                Shown on the dashboard, the wedding page and vendors&apos; read-only links. Either can be left blank.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="wedding-date" className="mb-1 block text-sm font-medium">
                    Wedding date
                  </label>
                  <input
                    id="wedding-date"
                    type="date"
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                    value={eventDate}
                    onChange={(e) => {
                      setEventDate(e.target.value);
                      setDetailsSaved(false);
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="wedding-venue" className="mb-1 block text-sm font-medium">
                    Venue
                  </label>
                  <input
                    id="wedding-venue"
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                    value={venueName}
                    onChange={(e) => {
                      setVenueName(e.target.value);
                      setDetailsSaved(false);
                    }}
                    maxLength={FIELD_LIMITS.venueName}
                  />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={savingDetails}
                  className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
                >
                  {savingDetails ? "Saving..." : "Save date and venue"}
                </button>
                {detailsSaved && (
                  <span role="status" className="text-sm text-green-700 dark:text-green-400">
                    Saved
                  </span>
                )}
              </div>
            </form>
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
                    data-blur-save=""
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                    value={sideLabel1}
                    onChange={(e) => {
                      setSideLabel1(e.target.value);
                      settingFields.markDirty("setting-side-1", (e.target.value.trim() || "Bride") !== wedding.sideLabel1);
                    }}
                    onBlur={() => {
                      settingFields.markDirty("setting-side-1", false);
                      void onSaveSideLabel(1);
                    }}
                    maxLength={FIELD_LIMITS.sideLabel}
                  />
                </div>
                <div>
                  <label htmlFor="side-label-2" className="mb-1 block text-sm font-medium">
                    Side 2
                  </label>
                  <input
                    id="side-label-2"
                    data-blur-save=""
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                    value={sideLabel2}
                    onChange={(e) => {
                      setSideLabel2(e.target.value);
                      settingFields.markDirty("setting-side-2", (e.target.value.trim() || "Groom") !== wedding.sideLabel2);
                    }}
                    onBlur={() => {
                      settingFields.markDirty("setting-side-2", false);
                      void onSaveSideLabel(2);
                    }}
                    maxLength={FIELD_LIMITS.sideLabel}
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
                data-blur-save=""
                aria-label="Wedding note"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm disabled:opacity-50"
                rows={3}
                maxLength={FIELD_LIMITS.weddingNote}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  settingFields.markDirty("setting-note", e.target.value.trim() !== (wedding.note ?? ""));
                }}
                onBlur={() => {
                  settingFields.markDirty("setting-note", false);
                  void onSaveNote();
                }}
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
                data-blur-save=""
                aria-label="RSVP cutoff date"
                type="date"
                className="w-full max-w-xs rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm disabled:opacity-50"
                value={rsvpCutoffDate}
                onChange={(e) => {
                  setRsvpCutoffDate(e.target.value);
                  settingFields.markDirty("setting-rsvp-cutoff", e.target.value.trim() !== (wedding.rsvpCutoffDate ?? ""));
                }}
                onBlur={(e) => {
                  settingFields.markDirty("setting-rsvp-cutoff", false);
                  void onSaveRsvpCutoff(e.currentTarget);
                }}
                disabled={savingRsvpCutoff}
              />
            </div>
          )}
        </>
      )}

      {error && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

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
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3"
            >
              {/* TS-191: a long name or address wraps instead of pushing the controls off a phone screen. */}
              <div className="min-w-0">
                <p className="break-words font-medium [overflow-wrap:anywhere]">{c.userName}</p>
                {c.userEmail && <p className="break-all text-sm text-neutral-500 dark:text-neutral-400">{c.userEmail}</p>}
              </div>
              {isOwner ? (
                <div className="flex flex-wrap items-center gap-2">
                  {/* TS-195/TS-199: arrowing through these no longer saves (and notifies) each
                      level on the way -- Enter or leaving the list saves; a mouse pick saves at once. */}
                  <CommitSelect
                    id={`collaborator-${c.id}-role`}
                    aria-label={`Role for ${c.userName}`}
                    className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
                    value={c.role}
                    onCommit={(v) => onChangeRole(c.id, v as CollaboratorRole)}
                    onPendingChange={(p) => settingFields.markDirty(`collaborator-${c.id}-role`, p)}
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </CommitSelect>
                  <CommitSelect
                    id={`collaborator-${c.id}-level`}
                    aria-label={`Access level for ${c.userName}`}
                    className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
                    value={c.permissionLevel}
                    onCommit={(v) => onChangeLevel(c.id, v as CollaboratorPermission)}
                    onPendingChange={(p) => settingFields.markDirty(`collaborator-${c.id}-level`, p)}
                  >
                    {LEVELS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </CommitSelect>
                  <ConfirmDeleteButton
                    id={`collaborator-${c.id}-remove`}
                    ariaLabel={`Remove ${c.userName}`}
                    question={`Remove ${c.userName}'s access to this wedding? They'll lose access right away. You can invite them again later. ${LINKS_KEEP_WORKING}`}
                    confirmLabel="Yes, remove access"
                    onConfirm={() => onRemove(c.id)}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-end gap-1">
                  <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-3 py-1 text-sm text-neutral-600 dark:text-neutral-300">
                    {LEVELS.find((l) => l.value === c.permissionLevel)?.label}
                  </span>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">{roleLabel(c.role)}</span>
                  {/* TS-148: anyone can take themselves off a wedding. */}
                  {c.userId === currentUserId && (
                    <ConfirmDeleteButton
                      label="Leave this wedding"
                      question="Leave this wedding? You'll lose access right away. The owner can invite you again."
                      confirmLabel="Yes, leave"
                      busyLabel="Leaving…"
                      onConfirm={async () => {
                        try {
                          await api.delete(`/api/v1/weddings/${weddingId}/collaborators/${c.id}`);
                          router.push("/dashboard");
                        } catch (err) {
                          setError(err instanceof ApiError ? err.message : "Couldn't leave this wedding.");
                        }
                      }}
                    />
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {loweredAccessNote && (
        <p role="status" className="mt-3 text-sm text-amber-800 dark:text-amber-300">
          {loweredAccessNote}
        </p>
      )}

      {/* TS-179 (Tom's decision): the owner replaces every guest RSVP link and vendor share link at
          once, so links copied by someone who no longer has access stop working. No emails go out. */}
      {isOwner && (
        <div className="mt-8 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
          <h3 className="mb-1 text-sm font-medium">Reset all guest and vendor links</h3>
          <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
            Gives every guest RSVP link and vendor link a new address, so the old ones stop working —
            for example after removing someone who may have copied them. Nobody is emailed: guests and
            vendors will need their new links, which you can send from the guest list and the budget tab.
          </p>
          <ConfirmDeleteButton
            label="Reset all guest and vendor links"
            question="Reset every guest RSVP link and vendor link? The old links stop working straight away, and guests and vendors will need their new links — nothing is emailed automatically."
            confirmLabel="Yes, reset all links"
            busyLabel="Resetting…"
            className="rounded-md border border-red-300 dark:border-red-700 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
            onConfirm={onResetLinks}
          />
          {resetLinksDone && (
            <p role="status" className="mt-2 text-sm text-green-700 dark:text-green-400">
              {resetLinksDone}
            </p>
          )}
          {resetLinksError && (
            <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
              {resetLinksError}
            </p>
          )}
        </div>
      )}

      {/* TS-105: the owner hands the wedding to someone who already has access. Needed before the
          owner can delete their account, so no wedding is ever left with nobody in charge. */}
      {isOwner && collaborators.length > 0 && (
        <div className="mt-8 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
          <h3 className="mb-1 text-sm font-medium">Hand off this wedding</h3>
          <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
            Make someone with access the owner. You&apos;ll stay on as a collaborator with Edit access (ask the new
            owner to make you a Couple member if you need to approve the plan), and they&apos;ll
            manage who has access from then on.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="New owner"
              className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
              value={handOffTo}
              onChange={(e) => setHandOffTo(e.target.value)}
            >
              <option value="">Choose a person…</option>
              {collaborators.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.userName}
                </option>
              ))}
            </select>
            <ConfirmDeleteButton
              label="Hand off"
              disabled={!handOffTo}
              question={`Make ${collaborators.find((c) => c.id === handOffTo)?.userName ?? "them"} the owner of this wedding? You'll stay on as a collaborator with Edit access. Only the new owner can undo this.`}
              confirmLabel="Yes, hand it off"
              busyLabel="Handing off…"
              className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
              onConfirm={onHandOff}
            />
          </div>
          {/* TS-199: shown next to the button that was used, not at the top of the tab. */}
          {handOffError && (
            <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
              {handOffError}
            </p>
          )}
        </div>
      )}

      {/* TS-161: owner only. Typing the wedding's name first makes it hard to do by accident. */}
      {isOwner && wedding && (
        <div className="mt-8 rounded-lg border border-red-300 dark:border-red-800 p-4">
          <h3 className="mb-1 text-sm font-medium">Delete this wedding</h3>
          <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
            Deletes the wedding for everyone: its guests, tables, seating plans, comments, timeline,
            budget and every RSVP and vendor link. This can&apos;t be undone.
          </p>
          <label className="mb-1 block text-sm" htmlFor="delete-wedding-confirm">
            Type the wedding&apos;s name, <span className="font-medium">{wedding.name}</span>, to confirm
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              maxLength={FIELD_LIMITS.weddingName}
              id="delete-wedding-confirm"
              className="min-w-0 flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm"
              value={deleteConfirmName}
              onChange={(e) => setDeleteConfirmName(e.target.value)}
              autoComplete="off"
            />
            <ConfirmDeleteButton
              label="Delete wedding"
              disabled={deleteConfirmName.trim() !== wedding.name.trim()}
              question={`Delete "${wedding.name}" for everyone? This can't be undone.`}
              confirmLabel="Yes, delete wedding"
              busyLabel="Deleting…"
              className="rounded-md border border-red-300 dark:border-red-700 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
              onConfirm={onDeleteWedding}
            />
          </div>
          {deleteError && (
            <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
              {deleteError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
