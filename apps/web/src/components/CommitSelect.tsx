"use client";

import { useRef, useState } from "react";

// TS-199: a list that saves itself (a guest's Side or RSVP, a collaborator's access level or role)
// used to save on every change. With the keyboard, the arrow keys change a closed list's value one
// step at a time, so arrowing from Pending to Declined saved Confirmed on the way (and could send
// an RSVP-changed notice for it). Now:
// - picked with the mouse or a finger (the list's own pop-up), it saves straight away, as before;
// - changed with the arrow keys (or by typing a letter), it waits: Enter saves it, and so does
//   leaving the list (Tab, or clicking away). Escape puts back the saved value.
// While a keyboard change is waiting, the list counts as unsaved (onPendingChange) and carries
// data-blur-save, so Back on the wedding page saves it rather than asking.
export function CommitSelect({
  value,
  onCommit,
  onPendingChange,
  children,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onCommit: (value: string) => unknown;
  /** True while a keyboard change is waiting to be saved. */
  onPendingChange?: (pending: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  // What the list shows while a keyboard change waits; null when it shows the saved value.
  const [draft, setDraft] = useState<string | null>(null);
  const keyboardChanging = useRef(false);

  function setPending(next: string | null) {
    setDraft(next);
    onPendingChange?.(next !== null);
  }
  function commit(next: string | null) {
    setPending(null);
    if (next !== null && next !== value) onCommit(next);
  }

  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className={className}
      disabled={disabled}
      data-blur-save=""
      value={draft ?? value}
      onPointerDown={() => {
        keyboardChanging.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (draft !== null) {
            e.preventDefault();
            commit(draft);
          }
          keyboardChanging.current = false;
        } else if (e.key === "Escape") {
          if (draft !== null) {
            e.preventDefault();
            setPending(null);
          }
        } else if (e.key !== "Tab" && e.key !== "Shift") {
          // Arrow keys, Home/End, Page Up/Down and typing a letter all change a closed list.
          keyboardChanging.current = true;
        }
      }}
      onChange={(e) => {
        const next = e.target.value;
        if (keyboardChanging.current) setPending(next === value ? null : next);
        else commit(next);
      }}
      onBlur={() => {
        keyboardChanging.current = false;
        if (draft !== null) commit(draft);
      }}
    >
      {children}
    </select>
  );
}
