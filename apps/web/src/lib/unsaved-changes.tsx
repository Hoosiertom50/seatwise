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
  // TS-170: whether this page has added its extra history entry (see below).
  const guardPushed = useRef(false);
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
  // the router treats it as this same page). Pressing Back lands on the real entry for this page --
  // nothing visible changes -- and the page puts the extra entry back and asks first.
  useEffect(() => {
    if (count === 0) return;
    const pushGuard = () => window.history.pushState({ ...(window.history.state ?? {}), seatwiseGuard: true }, "", window.location.href);
    if (!guardPushed.current) {
      pushGuard();
      guardPushed.current = true;
    }
    const onPop = () => {
      if (dirtyKeys.current.size === 0) {
        guardPushed.current = false;
        return;
      }
      pushGuard();
      onBackRef.current?.();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [count]);

  const hasUnsaved = useCallback(() => dirtyKeys.current.size > 0, []);
  const clear = useCallback(() => {
    dirtyKeys.current.clear();
    setCount(0);
  }, []);
  /** TS-170: "Leave without saving" after Back -- skips the extra entry and the page itself. */
  const goBackPastPage = useCallback(() => {
    dirtyKeys.current.clear();
    setCount(0);
    const steps = guardPushed.current ? 2 : 1;
    guardPushed.current = false;
    window.history.go(-steps);
  }, []);
  return { registry, hasUnsaved, clear, goBackPastPage, Provider: UnsavedChangesContext.Provider };
}
