"use client";

import { useEffect, useSyncExternalStore } from "react";
import { saveStatusStore, saveStatusView } from "@/lib/save-status";

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

// TS-93: the one place a planner can always see whether their edits are reaching the server --
// Saving… / All changes saved / Not saved (with why) / Offline. Before this, a failed save only
// ever surfaced as a tab's own inline error, easy to miss while working on a floor plan, and a
// save that was merely slow looked identical to one that had landed.
//
// A failed edit has already been undone on screen by the tab that made it (every handler rolls its
// optimistic change back), so "Not saved" means "redo it" -- there is no queued change here to
// resend. Requests that got no response at all are already retried automatically by api-client
// before this ever shows a failure.
export function SaveStatusIndicator({ unsavedCount = 0 }: { unsavedCount?: number } = {}) {
  const status = useSyncExternalStore(
    saveStatusStore.subscribe,
    saveStatusStore.getSnapshot,
    saveStatusStore.getServerSnapshot
  );
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

  // Leaving (closing the tab, reloading, following an external link) while a save is still in
  // flight would silently drop it -- ask first.
  useEffect(() => {
    if (status.pending === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [status.pending]);

  // TS-206: the wording is decided in save-status.ts -- never "All changes saved" while a field on
  // the page is still unsaved, and nothing at all after Dismiss.
  const view = saveStatusView(status, { online, unsavedCount });
  let tone = "text-neutral-500 dark:text-neutral-400";
  let content: React.ReactNode = null;
  if (view.kind === "offline") {
    tone = "text-amber-700 dark:text-amber-400";
    content = "Offline — changes can't be saved until you reconnect";
  } else if (view.kind === "saving") {
    content = "Saving…";
  } else if (view.kind === "error") {
    tone = "text-red-700 dark:text-red-400";
    content = (
      <>
        <span title={status.lastError ?? undefined}>{view.message}</span>
        <button onClick={saveStatusStore.dismissError} className="ml-2 underline hover:no-underline">
          Dismiss
        </button>
      </>
    );
  } else if (view.kind === "saved") {
    tone = "text-green-700 dark:text-green-400";
    content = "All changes saved";
  }

  return (
    <p role="status" aria-live="polite" aria-label="Save status" className={`min-h-5 text-sm ${tone}`}>
      {content}
    </p>
  );
}
