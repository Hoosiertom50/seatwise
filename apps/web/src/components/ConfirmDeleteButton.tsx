"use client";

import { useEffect, useId, useRef, useState } from "react";

// TS-136: every action that permanently deletes something (a guest, a rule, a table, a timeline
// entry, a vendor, a collaborator's access, an invite, a template) asks first. Clicking the
// trigger shows an inline "Are you sure?" with two choices: the red confirm button goes ahead,
// Cancel (or Escape) leaves everything as it was. Cancel takes focus when the question opens, so
// a stray Enter never deletes anything.
export function ConfirmDeleteButton({
  label = "Remove",
  ariaLabel,
  question,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  disabled = false,
  className,
  busyLabel = "Removing…",
}: {
  /** The trigger button's visible text. */
  label?: string;
  /** The trigger's accessible name, e.g. "Remove Jane Smith" -- needed where many rows share a label. */
  ariaLabel?: string;
  /** What the planner is asked, e.g. "Remove Jane Smith from the guest list? This can't be undone." */
  question: string;
  /** The confirm button's text, e.g. "Yes, remove guest". */
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  /** Shown on the confirm button while it works. */
  busyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const questionId = useId();

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    // Put focus back where the planner was, so keyboard users don't lose their place.
    setTimeout(() => triggerRef.current?.focus(), 0);
  }

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled || open}
        className={
          className ??
          "rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
        }
      >
        {label}
      </button>
      {open && (
        <div
          role="alertdialog"
          aria-labelledby={questionId}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
          className="mt-2 flex w-full basis-full flex-wrap items-center gap-3 rounded-md bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
        >
          <span id={questionId} className="flex-1">
            {question}
          </span>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
          >
            {busy ? busyLabel : confirmLabel}
          </button>
          <button
            ref={cancelRef}
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {cancelLabel}
          </button>
        </div>
      )}
    </>
  );
}
