"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { UnsavedRegistry, LeavingFlag, couldntSaveNote, type UnsavedNote } from "./unsaved-registry";
import { isSigningOut } from "./log-out";

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
/** Review 15: how recent a refusal must be to be noted when its tab closes (see noteIfClosed). */
const RECENT_REFUSAL_MS = 2_000;

export function useUnsavedFields(): {
  markDirty: (key: string, dirty: boolean) => void;
  clearAll: () => void;
  trackSave: (key: string, save: Promise<unknown>) => Promise<boolean>;
  keepUnsaved: (key: string, field: string, reason: string) => void;
  noteIfClosed: (key: string, field: string, reason: string) => void;
} {
  const registry = useContext(UnsavedChangesContext);
  const keys = useRef(new Set<string>());
  // TS-206: false once the component has gone (its tab was closed). A save that fails after that
  // can't mark its box unsaved -- the box is gone, and the mark could never be cleared, so every
  // later tab click, reload and Back asked about nothing.
  const mounted = useRef(false);
  // Review 15: refusals answered while the tab was still open, kept for a moment -- see noteIfClosed.
  const recentRefusals = useRef<{ key: string; field: string; reason: string; at: number }[]>([]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const now = Date.now();
      for (const r of recentRefusals.current) {
        if (now - r.at < RECENT_REFUSAL_MS) registry?.addNote(couldntSaveNote(r.field, r.reason));
      }
      recentRefusals.current = [];
    };
  }, [registry]);
  const markDirty = useCallback(
    (key: string, dirty: boolean) => {
      if (dirty && !mounted.current) return;
      // PR #115 review: typing in the box again replaces a refusal it had -- its note no longer
      // applies (a retry that saved used to be followed by "Couldn't save" when the tab closed).
      if (dirty) recentRefusals.current = recentRefusals.current.filter((r) => r.key !== key);
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
  /**
   * Review 14: a save refused because the setting was changed elsewhere (409) -- with the tab still
   * open its box shows the latest and the message says so; once the tab has closed, the page shows
   * "Couldn't save <field>: <reason>" (the typing used to vanish without a word).
   */
  // Review 15: and when the answer comes back just before the tab closes -- the save starts as the
  // mouse goes down on another tab, the tab switches as it comes up, and a refusal in between showed
  // in the tab for a moment and was then gone. A refusal from the last couple of seconds is noted
  // when the tab closes.
  const noteIfClosed = useCallback(
    (key: string, field: string, reason: string) => {
      if (!mounted.current) registry?.addNote(couldntSaveNote(field, reason));
      else recentRefusals.current.push({ key, field, reason, at: Date.now() });
    },
    [registry]
  );
  return useMemo(
    () => ({ markDirty, clearAll, trackSave, keepUnsaved, noteIfClosed }),
    [markDirty, clearAll, trackSave, keepUnsaved, noteIfClosed]
  );
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
  /** The latest `reconcile` (below), for the registry's listener. */
  const reconcileNow = useRef<() => void>(() => {});
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
        // Review 14: the Back guard goes in at once, not after the next render -- a Back pressed in
        // that instant (typing pasted or filled in, then Back) left without asking.
        if (registry.hasUnsaved()) reconcileNow.current();
      }),
    [registry]
  );
  const needsGuard = useCallback(() => registry.hasUnsaved() || registry.isSaving(), [registry]);

  useEffect(() => {
    if (count === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      // Review 15: asked again as it fires -- "Leave without saving" then Log out clears the input and
      // opens the sign-in page in the same moment, before this listener comes off with the next
      // render, and the browser asked "Leave site?" on top of the page's own question.
      // PR #115 review: nor while going to the sign-in page after a log out (see goToSignIn).
      if (!registry.hasUnsaved() || isSigningOut()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [count, registry]);


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
  /** Waiting for that Back to land (see whenGuardSettled). */
  const guardSettled = useRef<(() => void)[]>([]);
  /** Set while the page is leaving on purpose, so the extra entry isn't taken off in the meantime. */
  // TS-218: a LeavingFlag (unsaved-registry.ts), so a cancelled reload's mark can be lifted.
  const [leaving] = useState(() => new LeavingFlag());
  // TS-206: a reload, or opening another address, while nothing is unsaved: the page is going, so
  // the extra history entry isn't taken off any more. A save that finished just then used to take it
  // off with history.back(), which cancelled the reload the person had just asked for.
  // TS-218: if the reload was cancelled, the mark is lifted the next time the page is used (a key, a
  // click or a tap) -- it used to stay for the page's whole life, switching the Back guard off.
  useEffect(() => {
    const going = () => {
      if (!registry.hasUnsaved()) leaving.pageGoing();
    };
    const used = () => {
      leaving.stillHere();
    };
    window.addEventListener("beforeunload", going);
    for (const type of ["keydown", "pointerdown", "input"] as const) window.addEventListener(type, used, true);
    return () => {
      window.removeEventListener("beforeunload", going);
      for (const type of ["keydown", "pointerdown", "input"] as const) window.removeEventListener(type, used, true);
    };
  }, [registry, leaving]);
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
    if (leaving.value || ignoreNextPop.current) return;
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
  }, [needsGuard, registry, leaving]);

  // Runs on load too: after a reload the extra entry is still there with nothing unsaved, and is
  // taken off here (before, one Back press then seemed to do nothing).
  useEffect(() => {
    reconcile();
  }, [count, saving, reconcile]);
  useEffect(() => {
    reconcileNow.current = reconcile;
  }, [reconcile]);

  useEffect(() => {
    pageUrl.current = window.location.href;
    const onPop = () => {
      // Back to some other page: the router is taking us there.
      if (window.location.href !== pageUrl.current) return;
      if (ignoreNextPop.current) {
        ignoreNextPop.current = false;
        reconcile();
        // PR #115 review: told a moment later, once the router has dealt with this Back too -- a page
        // opened straight away was replaced by the router putting this one back.
        const waiting = guardSettled.current.splice(0);
        window.setTimeout(() => {
          for (const settled of waiting) settled();
        }, 0);
        return;
      }
      if (leaving.value) return;
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
  }, [reconcile, needsGuard, leaving]);

  /**
   * PR #114 review: true while the page's own Back (taking its extra entry off, just after a save)
   * hasn't landed yet. Opening another page then -- Log out's sign-in page, say -- was cancelled
   * by that Back, leaving a signed-out wedding page on screen.
   */
  // PR #115 review: or about to start -- the extra entry is still there with nothing left unsaved,
  // and the render that takes it off hasn't come yet (a box just emptied, a link clicked in the same
  // moment). That Back then cancelled the page the link opened.
  const removalPending = useCallback(
    () => !leaving.value && !ignoreNextPop.current && onGuardEntry() && !needsGuard(),
    [leaving, needsGuard]
  );
  const guardSettling = useCallback(() => ignoreNextPop.current || removalPending(), [removalPending]);
  /** Resolves once that Back has landed (or after half a second, so leaving never hangs). */
  const whenGuardSettled = useCallback(() => {
    // PR #115 review: a Back about to start is started now, and waited for like any other.
    if (removalPending()) reconcileNow.current();
    return ignoreNextPop.current
      ? new Promise<void>((resolve) => {
          guardSettled.current.push(resolve);
          window.setTimeout(resolve, 500);
        })
      : Promise.resolve();
  }, [removalPending]);
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
    leaving.set();
    registry.clearDirty();
    return onGuardEntry();
  }, [registry, leaving]);
  /**
   * TS-170: "Leave without saving" after Back -- skips the extra entry and the page itself.
   * TS-175: if there's nothing before this page (it was opened in a fresh tab), `fallback` runs
   * instead (before, Leave did nothing there).
   */
  const goBackPastPage = useCallback((fallback: () => void) => {
    leaving.set();
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
  }, [registry, leaving]);
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
    guardSettling,
    whenGuardSettled,
    Provider: UnsavedChangesContext.Provider,
  };
}
