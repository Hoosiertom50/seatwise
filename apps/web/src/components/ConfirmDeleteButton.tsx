"use client";

import { useEffect, useId, useRef, useState } from "react";

// TS-212: a deleted row's stable neighbours -- the rows after and before it, and the heading above
// its list -- so focus has somewhere to go once the row has gone.
export type Neighbours = { next: Element | null; previous: Element | null; heading: HTMLElement | null };
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

export function rowNeighbours(trigger: HTMLElement | null): Neighbours {
  const row = trigger?.closest("li, tr, [data-row]") ?? null;
  const list = row?.parentElement ?? null;
  return { next: row?.nextElementSibling ?? null, previous: row?.previousElementSibling ?? null, heading: headingBefore(list) };
}

function headingBefore(element: Element | null): HTMLElement | null {
  for (let node: Element | null = element; node; node = node.parentElement) {
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (/^H[1-6]$/.test(sibling.tagName)) return sibling as HTMLElement;
      const inside = sibling.querySelectorAll("h1, h2, h3, h4, h5, h6");
      if (inside.length) return inside[inside.length - 1] as HTMLElement;
    }
  }
  return null;
}

export function focusNeighbour({ next, previous, heading }: Neighbours) {
  for (const row of [next, previous]) {
    const control = row?.isConnected ? row.querySelector<HTMLElement>(FOCUSABLE) : null;
    if (control) {
      control.focus();
      return;
    }
  }
  if (heading?.isConnected) {
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus();
  }
}

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
  id,
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
  /**
   * TS-199: a stable id for the trigger. Lists that take a row away first and put it back if the
   * delete fails draw a new trigger, so focus goes back to it by this id (the old one is gone).
   */
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const questionId = useId();

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  // TS-199: the trigger as it is now -- this one, or the one drawn in its place (found by id).
  function currentTrigger(): HTMLElement | null {
    const trigger = triggerRef.current;
    if (trigger && trigger.isConnected) return trigger;
    return id ? document.getElementById(id) : null;
  }

  function close() {
    setOpen(false);
    // Put focus back where the planner was, so keyboard users don't lose their place.
    setTimeout(() => currentTrigger()?.focus(), 0);
  }

  async function confirm() {
    setBusy(true);
    // TS-212: where focus goes if the row really is removed -- noted now, while the row is there.
    const neighbours = rowNeighbours(triggerRef.current);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setOpen(false);
      // TS-191: if the thing is still listed (removing it failed), focus goes back to the trigger
      // instead of falling to the top of the page. When the row is gone, the trigger went with it.
      // TS-199: including a row that was taken away first and put back -- found by its id (looked
      // for again a moment later, in case the row is still being drawn).
      // TS-212: and once it's really gone, focus moves to the next row (or the one before, or the
      // list's heading) -- it used to drop to the page, so the next Tab started from the top.
      setTimeout(() => {
        const trigger = currentTrigger();
        if (trigger) trigger.focus();
        else
          setTimeout(() => {
            const active = document.activeElement;
            if (active && active !== document.body && active.isConnected) return;
            const again = currentTrigger();
            if (again) again.focus();
            else focusNeighbour(neighbours);
          }, 100);
      }, 0);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
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
