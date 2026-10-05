"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

// TS-159: the wedding page shows one tab at a time, so switching tabs used to throw away whatever
// was half-typed in the tab being left (an Add guest / table / vendor form, an open edit, a draft
// comment) without a word. Each tab now reports whether it has unsaved input; the page asks before
// leaving a tab that does, and the browser asks before the page is closed or reloaded.

type Registry = {
  setDirty: (key: string, dirty: boolean) => void;
};

const UnsavedChangesContext = createContext<Registry | null>(null);

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
 * Wraps the tabs. `hasUnsaved` tells the page whether any tab has unsaved input right now; the
 * provider also asks the browser to confirm before the page is closed or reloaded while it does.
 */
export function useUnsavedChangesProvider({ onBackRequested }: { onBackRequested?: () => void } = {}) {
  const dirtyKeys = useRef(new Set<string>());
  const onBackRef = useRef(onBackRequested);
  useEffect(() => {
    onBackRef.current = onBackRequested;
  }, [onBackRequested]);
  const [count, setCount] = useState(0);
  const setDirty = useCallback((key: string, dirty: boolean) => {
    const had = dirtyKeys.current.has(key);
    if (dirty && !had) dirtyKeys.current.add(key);
    else if (!dirty && had) dirtyKeys.current.delete(key);
    else return;
    setCount(dirtyKeys.current.size);
  }, []);
  const registry = useMemo(() => ({ setDirty }), [setDirty]);

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
  const onGuardEntry = () => window.history.state?.seatwiseGuard === true;

  const reconcile = useCallback(() => {
    if (leaving.current || ignoreNextPop.current) return;
    if (pageUrl.current !== null && window.location.href !== pageUrl.current) return;
    if (dirtyKeys.current.size > 0 && !onGuardEntry()) {
      pageUrl.current = window.location.href;
      window.history.pushState({ ...(window.history.state ?? {}), seatwiseGuard: true }, "", window.location.href);
    } else if (dirtyKeys.current.size === 0 && onGuardEntry()) {
      ignoreNextPop.current = true;
      window.history.back();
    }
  }, []);

  // Runs on load too: after a reload the extra entry is still there with nothing unsaved, and is
  // taken off here (before, one Back press then seemed to do nothing).
  useEffect(() => {
    reconcile();
  }, [count, reconcile]);

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
      if (dirtyKeys.current.size > 0 && !onGuardEntry()) {
        // The user pressed Back from the extra entry: put it back and ask.
        reconcile();
        onBackRef.current?.();
        return;
      }
      reconcile();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [reconcile]);

  const hasUnsaved = useCallback(() => dirtyKeys.current.size > 0, []);
  const clear = useCallback(() => {
    dirtyKeys.current.clear();
    setCount(0);
  }, []);
  /**
   * TS-175: for leaving through a link once the user has said "leave without saving". Returns true
   * when the page is on its extra history entry, in which case the caller should `router.replace`
   * (so the extra entry becomes the new page instead of being left behind as a dead entry).
   */
  const releaseForLink = useCallback(() => {
    leaving.current = true;
    dirtyKeys.current.clear();
    setCount(0);
    return onGuardEntry();
  }, []);
  /**
   * TS-170: "Leave without saving" after Back -- skips the extra entry and the page itself.
   * TS-175: if there's nothing before this page (it was opened in a fresh tab), `fallback` runs
   * instead (before, Leave did nothing there).
   */
  const goBackPastPage = useCallback((fallback: () => void) => {
    leaving.current = true;
    dirtyKeys.current.clear();
    setCount(0);
    window.history.go(onGuardEntry() ? -2 : -1);
    // If the page is still here shortly after, there was nowhere to go back to.
    const timer = window.setTimeout(() => {
      if (window.location.href === pageUrl.current) fallback();
    }, 500);
    window.addEventListener("pagehide", () => window.clearTimeout(timer), { once: true });
  }, []);
  return { registry, hasUnsaved, clear, releaseForLink, goBackPastPage, Provider: UnsavedChangesContext.Provider };
}
