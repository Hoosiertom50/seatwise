"use client";

import { useState } from "react";

// TS-199: a "Move to…" / "Seat at…" list used to move the guest the moment its value changed. With
// the keyboard, the arrow keys change a closed list's value one step at a time, so arrowing down
// to the third table moved the guest to the first and second on the way. Choosing in the list now
// only picks a table; the button next to it makes the move (it stays off until a table is picked).
// Afterwards focus goes back to the guest's list by its id -- the guest's row is often drawn again
// (under their new table), so the old element is gone.
export function PickThenActControl({
  id,
  label,
  placeholder,
  options,
  actLabel,
  actAriaLabel,
  busy = false,
  busyLabel,
  disabled = false,
  onAct,
  selectClassName,
  buttonClassName,
}: {
  /** Stable per guest -- used to find the list again after the move. */
  id: string;
  /** The list's accessible name, e.g. "Move Jane Smith to a different table". */
  label: string;
  /** The list's first, empty choice, e.g. "Move to...". */
  placeholder: string;
  options: { value: string; label: string }[];
  /** The button's text, e.g. "Move" or "Seat". */
  actLabel: string;
  /** The button's accessible name, e.g. "Move Jane Smith". */
  actAriaLabel: string;
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  onAct: (value: string) => unknown;
  selectClassName?: string;
  buttonClassName?: string;
}) {
  const [picked, setPicked] = useState("");
  // A pick that is no longer offered (the table filled up, or was removed) counts as no pick.
  const value = options.some((o) => o.value === picked) ? picked : "";

  async function act() {
    if (!value || busy || disabled) return;
    const chosen = value;
    setPicked("");
    try {
      await onAct(chosen);
    } finally {
      // Back to this guest's list (found by id: the row may have been drawn again elsewhere),
      // unless the planner has already moved on to another control.
      setTimeout(() => {
        const active = document.activeElement;
        const lost = !active || active === document.body || !active.isConnected;
        const stillHere = active instanceof HTMLElement && active.id === `${id}-act`;
        if (lost || stillHere) document.getElementById(id)?.focus();
      }, 0);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-1">
      <select
        id={id}
        aria-label={label}
        className={
          selectClassName ??
          "min-h-11 max-w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm disabled:opacity-50"
        }
        value={value}
        disabled={disabled || busy}
        onChange={(e) => setPicked(e.target.value)}
        onKeyDown={(e) => {
          // Enter on the list is the same as the button, once a table is picked.
          if (e.key === "Enter" && value) {
            e.preventDefault();
            void act();
          }
        }}
      >
        <option value="" disabled>
          {busy && busyLabel ? busyLabel : placeholder}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        id={`${id}-act`}
        type="button"
        aria-label={actAriaLabel}
        onClick={() => void act()}
        disabled={!value || busy || disabled}
        className={
          buttonClassName ??
          "min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
        }
      >
        {actLabel}
      </button>
    </span>
  );
}
