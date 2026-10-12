"use client";

import { useEffect, useRef, useState } from "react";
import type { AgeCategory, GuestDTO, GuestTier } from "@seatwise/shared";
import { FIELD_LIMITS, GUEST_TIER_LABELS, hasForbiddenControlCharacter } from "@seatwise/shared";

// TS-202: a guest's party size, tier, household, age category and accessible-table need could
// only be set on the Add guest form -- a guest added as a party of one could never RSVP for two,
// and a mistyped tier or household could only be fixed by re-importing or deleting the guest
// (losing their seat, rules and RSVP link). "Edit details" opens these fields in the guest's row;
// Save sends them through the same guest save as the row's other fields (with the revision), and
// Cancel puts the saved values back. Only Owner and Edit see it.

const TIERS: GuestTier[] = ["VIP", "FAMILY", "FRIEND", "PLUS_ONE", "OTHER"];
const AGE_CATEGORIES: AgeCategory[] = ["ADULT", "CHILD", "INFANT"];

export type GuestDetailsChanges = Partial<
  Pick<GuestDTO, "headcount" | "tier" | "partyName" | "ageCategory" | "requiresAccessibleTable">
>;

interface Draft {
  headcount: string;
  tier: GuestTier;
  partyName: string;
  ageCategory: AgeCategory;
  requiresAccessibleTable: boolean;
}

function draftOf(guest: GuestDTO): Draft {
  return {
    headcount: String(guest.headcount),
    tier: guest.tier,
    partyName: guest.partyName ?? "",
    ageCategory: guest.ageCategory,
    requiresAccessibleTable: guest.requiresAccessibleTable,
  };
}

/** TS-202: only what the form changes, compared with the guest as saved. */
export function changedDetails(draft: Draft, guest: GuestDTO): GuestDetailsChanges {
  const out: GuestDetailsChanges = {};
  const headcount = Number(draft.headcount);
  if (draft.headcount.trim() !== "" && headcount !== guest.headcount) out.headcount = headcount;
  if (draft.tier !== guest.tier) out.tier = draft.tier;
  const partyName = draft.partyName.trim() || null;
  if (partyName !== (guest.partyName ?? null)) out.partyName = partyName;
  if (draft.ageCategory !== guest.ageCategory) out.ageCategory = draft.ageCategory;
  if (draft.requiresAccessibleTable !== guest.requiresAccessibleTable) out.requiresAccessibleTable = draft.requiresAccessibleTable;
  return out;
}

/** A field the planner left as it was takes the newer value; a field they changed keeps theirs. */
function rebased(draft: Draft, was: Draft, now: Draft): Draft {
  const out = { ...draft };
  for (const key of Object.keys(draft) as (keyof Draft)[]) {
    if (draft[key] === was[key]) (out as Record<keyof Draft, unknown>)[key] = now[key];
  }
  return out;
}

// TS-193: the household box takes no hidden control characters (the server refuses them).
function withoutControlCharacters(value: string): string {
  return Array.from(value)
    .filter((c) => !hasForbiddenControlCharacter(c))
    .join("");
}

export function GuestDetailsEditor({
  guest,
  onSave,
  onDirtyChange,
}: {
  guest: GuestDTO;
  /** Saves the changes; resolves to null when saved, or the message to show (nothing saved). */
  onSave: (changes: GuestDetailsChanges) => Promise<string | null>;
  /** True while the form is open with values that differ from what's saved. */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  // The guest as the form last took it. When a newer copy arrives while the form is open (someone
  // else's change, shown after a refused save, or another field of the row saved), the fields the
  // planner hasn't touched follow it, and what they typed stays -- so Save doesn't undo the other
  // change with values they never chose.
  const [base, setBase] = useState<GuestDTO | null>(null);
  if (draft !== null && base !== null && base.revision !== guest.revision) {
    setBase(guest);
    setDraft(rebased(draft, draftOf(base), draftOf(guest)));
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  // Where focus goes once the form opens or closes.
  const focusNext = useRef<"form" | "button" | null>(null);
  const name = `${guest.firstName} ${guest.lastName}`;
  const idBase = `guest-${guest.id}-details`;

  const dirty = draft !== null && Object.keys(changedDetails(draft, guest)).length > 0;
  const reportDirty = useRef(onDirtyChange);
  useEffect(() => {
    reportDirty.current = onDirtyChange;
  });
  useEffect(() => {
    reportDirty.current(dirty);
  }, [dirty]);
  useEffect(() => () => reportDirty.current(false), []);

  const isOpen = draft !== null;
  useEffect(() => {
    if (focusNext.current === "form") firstField.current?.focus();
    else if (focusNext.current === "button") editButton.current?.focus();
    focusNext.current = null;
  }, [isOpen]);

  function open() {
    setError(null);
    focusNext.current = "form";
    setBase(guest);
    setDraft(draftOf(guest));
  }
  function close() {
    setError(null);
    focusNext.current = "button";
    setBase(null);
    setDraft(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || saving) return;
    const headcount = Number(draft.headcount);
    if (draft.headcount.trim() === "" || !Number.isInteger(headcount) || headcount < 1 || headcount > 20) {
      setError("Party size must be a whole number from 1 to 20.");
      return;
    }
    const changes = changedDetails(draft, guest);
    if (Object.keys(changes).length === 0) {
      close();
      return;
    }
    setSaving(true);
    setError(null);
    const message = await onSave(changes);
    setSaving(false);
    // Refused or not saved: the typed values stay, with the reason beside them.
    if (message !== null) setError(message);
    else close();
  }

  if (draft === null) {
    return (
      <button
        ref={editButton}
        type="button"
        id={`${idBase}-edit`}
        onClick={open}
        aria-expanded={false}
        aria-label={`Edit details for ${name}`}
        className="mt-1 text-xs text-neutral-600 dark:text-neutral-300 underline hover:no-underline"
      >
        Edit details
      </button>
    );
  }

  const inputClass = "w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm";
  return (
    <form
      onSubmit={onSubmit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
      aria-label={`Details for ${name}`}
      className="mt-2 grid max-w-xl grid-cols-1 gap-2 rounded-md border border-neutral-200 dark:border-neutral-700 p-3 sm:grid-cols-2"
    >
      {/* TS-193: the same order as the Add guest form, left to right then down. */}
      <div>
        <label htmlFor={`${idBase}-partyName`} className="mb-1 block text-xs font-medium">
          Party / household
        </label>
        <input
          ref={firstField}
          id={`${idBase}-partyName`}
          maxLength={FIELD_LIMITS.partyName}
          className={inputClass}
          value={draft.partyName}
          onChange={(e) => setDraft({ ...draft, partyName: withoutControlCharacters(e.target.value) })}
        />
      </div>
      <div>
        <label htmlFor={`${idBase}-headcount`} className="mb-1 block text-xs font-medium">
          Party size (headcount)
        </label>
        <input
          id={`${idBase}-headcount`}
          type="number"
          inputMode="numeric"
          min={1}
          max={20}
          className={inputClass}
          value={draft.headcount}
          // Digits only (some browsers let letters into a number box).
          onChange={(e) => setDraft({ ...draft, headcount: e.target.value.replace(/\D/g, "").slice(0, 2) })}
        />
      </div>
      <div>
        <label htmlFor={`${idBase}-tier`} className="mb-1 block text-xs font-medium">
          Tier
        </label>
        <select
          id={`${idBase}-tier`}
          className={inputClass}
          value={draft.tier}
          onChange={(e) => setDraft({ ...draft, tier: e.target.value as GuestTier })}
        >
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {GUEST_TIER_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idBase}-ageCategory`} className="mb-1 block text-xs font-medium">
          Age category
        </label>
        <select
          id={`${idBase}-ageCategory`}
          className={inputClass}
          value={draft.ageCategory}
          onChange={(e) => setDraft({ ...draft, ageCategory: e.target.value as AgeCategory })}
        >
          {AGE_CATEGORIES.map((a) => (
            <option key={a} value={a}>
              {a.charAt(0) + a.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          id={`${idBase}-accessible`}
          type="checkbox"
          checked={draft.requiresAccessibleTable}
          onChange={(e) => setDraft({ ...draft, requiresAccessibleTable: e.target.checked })}
        />
        Requires an accessible table
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400 sm:col-span-2">
          {error}
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <button
          type="submit"
          // TS-225: aria-disabled (not disabled) while saving, so Save keeps keyboard focus when a
          // save is refused -- a disabled button dropped it to the page. onSubmit ignores it meanwhile.
          aria-disabled={saving || undefined}
          className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-3 py-1 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 aria-disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save details"}
        </button>
        <button
          type="button"
          onClick={close}
          disabled={saving}
          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
