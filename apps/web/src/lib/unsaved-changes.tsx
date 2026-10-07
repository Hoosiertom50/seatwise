"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { UnsavedRegistry, couldntSaveNote, type UnsavedNote } from "./unsaved-registry";

// TS-159: the wedding page shows one tab at a time, so switching tabs used to throw away whatever
// was half-typed in the tab being left (an Add guest / table / vendor form, an open edit, a draft
// comment) without a word. Each tab now reports whether it has unsaved input; the page asks before
// leaving a tab that does, and the browser asks before the page is closed or reloaded.

// TS-206: the bookkeeping itself lives in unsaved-registry.ts (dirty fields, saves still on their
// way, and notes about saves that failed after their tab closed).
const UnsavedChangesContext = createContext<UnsavedRegistry | null>(null);

/** A tab calls this with whether it currently has input that would be lost. */
export function useUnsavedChanges(key: string, dirty: boolean): void {
  const registry = useContext(UnsavedChangesContext);
  useEffect(() => {
    registry?.setDirty(key, dirty);
  }, [registry, key, dirty]);
  // Leaving the tab (it unmounts) means its input is gone either way.
  useEffect(() => () => registry?.setDirty(key, false), [registry, key]);
}

/**
 * TS-182: for fields that save when you leave them (a guest row's name, email or notes; the
 * wedding settings). They had no unsaved state of their own, so a reload or Back while one was
 * half-typed lost it without a word. The returned `markDirty(key, dirty)` reports one field at a
 * time (dirty while its text differs from what's saved); `clearAll` forgets every field this
 * component reported, and leaving the component does the same.
 */
export function useUnsavedFields(): {
  markDirty: (key: string, dirty: boolean) => void;
  clearAll: () => void;
  trackSave: (key: string, save: Promise<unknown>) => Promise<boolean>;
  keepUnsaved: (key: string, field: string, reason: string) => void;
} {
  const registry = useContext(UnsavedChangesContext);
  const keys = useRef(new Set<string>());
  // TS-206: false once the component has gone (its tab was closed). A save that fails after that
  // can't mark its box unsaved -- the box is gone, and the mark could never be cleared, so every
  // later tab click, reload and Back asked about nothing.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const markDirty = useCallback(
    (key: string, dirty: boolean) => {
      if (dirty && !mounted.current) return;
      if (dirty) keys.current.add(key);
      else keys.current.delete(key);
      registry?.setDirty(key, dirty);
    },
    [registry]
  );
  const clearAll = useCallback(() => {
    for (const key of keys.current) registry?.setDirty(key, false);
    keys.current.clear();
  }, [registry]);
  useEffect(() => clearAll, [clearAll]);
  /**
   * TS-206: a box that saves when you leave it registers its save, so Back can wait for it (and
   * stay if it fails). Resolve the promise to false when the save didn't go through.
   */
  const trackSave = useCallback(
    (key: string, save: Promise<unknown>) =>
      registry ? registry.trackSave(key, save) : Promise.resolve(save).then((r) => r !== false, () => false),
    [registry]
  );
  /**
   * TS-206: a save failed and the typing was kept in its box. While the tab is open the box counts
   * as unsaved (as before); once the tab has closed the page shows "Couldn't save <field>: <reason>"
   * instead.
   */
  const keepUnsaved = useCallback(
    (key: string, field: string, reason: string) => {
      if (mounted.current) markDirty(key, true);
      else registry?.addNote(couldntSaveNote(field, reason));
    },
    [markDirty, registry]
  );
  return useMemo(() => ({ markDirty, clearAll, trackSave, keepUnsaved }), [markDirty, clearAll, trackSave, keepUnsaved]);
}

/**
 * Wraps the tabs. `hasUnsaved` tells the page whether any tab has unsaved input right now; the
 * provider also asks the browser to confirm before the page is closed or reloaded while it does.
 */
export function useUnsavedChangesProvider({ onBackRequested }: { onBackRequested?: () => void } = {}) {
  const [registry] = useState(() => new UnsavedRegistry());
  const onBackRef = useRef(onBackRequested);
  useEffect(() => {
    onBackRef.current = onBackRequested;
  }, [onBackRequested]);
  const [count, setCount] = useState(0);
  // TS-206: saves still on their way keep the page's extra history entry (below) in place, so a
  // Back pressed meanwhile is caught and can wait for them.
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState<readonly UnsavedNote[]>([]);
  useEffect(
    () =>
      registry.subscribe(() => {
        setCount(registry.dirtyCount());
        setSaving(registry.isSaving());
        setNotes(registry.notes());
      }),
    [registry]
  );
  const needsGuard = useCallback(() => registry.hasUnsaved() || registry.isSaving(), [registry]);

  useEffect(() => {
    if (count === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [count]);


  // TS-170: the browser's Back button (or a back swipe) moves within the app without unloading the
  // page, so "beforeunload" never fires and half-typed input was lost without a word. While there's
  // unsaved input, the page adds one extra history entry for itself (a copy of the current one, so
  // the router treats it as this same page, marked `seatwiseGuard`). Pressing Back lands on the real
  // entry for this page -- nothing visible changes -- and the page puts the extra entry back and asks.
  // TS-175: whether we're on the extra entry is read from the browser's own history state every time
  // (it was a flag in memory, which went wrong after a save or a reload), the listener stays for the
  // page's whole life (it was only there while something was unsaved, so the guard worked once), and
  // the extra entry is taken back off as soon as there's nothing unsaved.
  const pageUrl = useRef<string | null>(null);
  /** A Back the page made itself (taking the extra entry off) -- not the user's. */
  const ignoreNextPop = useRef(false);
  /** Set while the page is leaving on purpose, so the extra entry isn't taken off in the meantime. */
  const leaving = useRef(false);
  // TS-206: a reload, or opening another address, while nothing is unsaved: the page is going, so
  // the extra history entry isn't taken off any more. A save that finished just then used to take it
  // off with history.back(), which cancelled the reload the person had just asked for.
  useEffect(() => {
    const going = () => {
      if (!registry.hasUnsaved()) leaving.current = true;
    };
    window.addEventListener("beforeunload", going);
    return () => window.removeEventListener("beforeunload", going);
  }, [registry]);
  /** False once this page has closed -- a timer it started must then do nothing (see goBackPastPage). */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onGuardEntry = () => window.history.state?.seatwiseGuard === true;

  const reconcile = useCallback(() => {
    if (leaving.current || ignoreNextPop.current) return;
    if (pageUrl.current !== null && window.location.href !== pageUrl.current) return;
    // TS-206: added only for unsaved input; a save on its way just keeps one already there (so a
    // pick from a list doesn't add and take off a history entry every time).
    if (registry.hasUnsaved() && !onGuardEntry()) {
      pageUrl.current = window.location.href;
      window.history.pushState({ ...(window.history.state ?? {}), seatwiseGuard: true }, "", window.location.href);
    } else if (!needsGuard() && onGuardEntry()) {
      ignoreNextPop.current = true;
      window.history.back();
    }
  }, [needsGuard, registry]);

  // Runs on load too: after a reload the extra entry is still there with nothing unsaved, and is
  // taken off here (before, one Back press then seemed to do nothing).
  useEffect(() => {
    reconcile();
  }, [count, saving, reconcile]);

  useEffect(() => {
    pageUrl.current = window.location.href;
    const onPop = () => {
      // Back to some other page: the router is taking us there.
      if (window.location.href !== pageUrl.current) return;
      if (ignoreNextPop.current) {
        ignoreNextPop.current = false;
        reconcile();
        return;
      }
      if (leaving.current) return;
      if (needsGuard() && !onGuardEntry()) {
        // The user pressed Back from the extra entry: put it back and ask.
        reconcile();
        onBackRef.current?.();
        return;
      }
      reconcile();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [reconcile, needsGuard]);

  const hasUnsaved = useCallback(() => registry.hasUnsaved(), [registry]);
  const clear = useCallback(() => registry.clearDirty(), [registry]);
  /** TS-206: waits for every save-on-leave box's save; true when all of them saved. */
  const waitForSaves = useCallback(() => registry.waitForSaves(), [registry]);
  const isSaving = useCallback(() => registry.isSaving(), [registry]);
  const dismissNote = useCallback((id: number) => registry.dismissNote(id), [registry]);
  /**
   * TS-175: for leaving through a link once the user has said "leave without saving". Returns true
   * when the page is on its extra history entry, in which case the caller should `router.replace`
   * (so the extra entry becomes the new page instead of being left behind as a dead entry).
   */
  const releaseForLink = useCallback(() => {
    leaving.current = true;
    registry.clearDirty();
    return onGuardEntry();
  }, [registry]);
  /**
   * TS-170: "Leave without saving" after Back -- skips the extra entry and the page itself.
   * TS-175: if there's nothing before this page (it was opened in a fresh tab), `fallback` runs
   * instead (before, Leave did nothing there).
   */
  const goBackPastPage = useCallback((fallback: () => void) => {
    leaving.current = true;
    registry.clearDirty();
    window.history.go(onGuardEntry() ? -2 : -1);
    // If the page is still here shortly after, there was nowhere to go back to.
    // TS-199: only while this page is still open -- leaving within the app doesn't fire pagehide,
    // so the timer outlived the page, and reopening the same wedding within half a second (the
    // page's address again) sent it straight back to the dashboard.
    const timer = window.setTimeout(() => {
      if (mounted.current && window.location.href === pageUrl.current) fallback();
    }, 500);
    window.addEventListener("pagehide", () => window.clearTimeout(timer), { once: true });
  }, [registry]);
  return {
    registry,
    hasUnsaved,
    /** TS-206: how many fields are unsaved right now (the header never says "All changes saved" then). */
    unsavedCount: count,
    clear,
    isSaving,
    waitForSaves,
    notes,
    dismissNote,
    releaseForLink,
    goBackPastPage,
    Provider: UnsavedChangesContext.Provider,
  };
}
