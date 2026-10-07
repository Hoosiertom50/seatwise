// TS-93: one app-wide record of whether the user's edits are actually reaching the server, fed by
// api-client for every write (POST/PATCH/DELETE) and read by SaveStatusIndicator. Every edit in the
// app already goes through api-client, so tracking it here -- rather than in each tab's handlers --
// means no edit path can be missed, and a new one is covered automatically.
//
// Kept framework-free (a plain subscribe/getSnapshot pair for React's useSyncExternalStore) so it
// holds no React state of its own and survives client-side navigation between pages.

export interface SaveStatus {
  /** Writes sent and not yet answered. */
  pending: number;
  /** Why the most recent write didn't save, until a later write succeeds or it's dismissed. */
  lastError: string | null;
  /** When a write last succeeded (ms since epoch), or null if none has this page lifetime. */
  lastSavedAt: number | null;
}

let status: SaveStatus = { pending: 0, lastError: null, lastSavedAt: null };
const listeners = new Set<() => void>();

function set(next: Partial<SaveStatus>) {
  status = { ...status, ...next };
  listeners.forEach((l) => l());
}

export const saveStatusStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): SaveStatus {
    return status;
  },
  // A stable server snapshot -- nothing is ever saving during server rendering.
  getServerSnapshot(): SaveStatus {
    return SERVER_SNAPSHOT;
  },
  // TS-206: Dismiss hides the failure and shows nothing -- it used to turn the header green with
  // "All changes saved", though the failed change was never saved.
  dismissError() {
    set({ lastError: null, lastSavedAt: null });
  },
  /** Forget saved/failed history (e.g. on opening a different wedding, so one wedding's "Not
   * saved" never appears on another). In-flight writes are still counted. */
  resetHistory() {
    set({ lastError: null, lastSavedAt: null });
  },
};
const SERVER_SNAPSHOT: SaveStatus = { pending: 0, lastError: null, lastSavedAt: null };

export function writeStarted() {
  set({ pending: status.pending + 1 });
}

export function writeSucceeded() {
  set({ pending: Math.max(0, status.pending - 1), lastError: null, lastSavedAt: Date.now() });
}

// TS-124: the server answered with a question ("guests are seated here -- remove anyway?"), not
// a failure: nothing was saved and nothing was lost, so the indicator neither reports an error nor
// claims a save.
export function writeAwaitingConfirmation() {
  set({ pending: Math.max(0, status.pending - 1) });
}

export function writeFailed(reason: string) {
  set({ pending: Math.max(0, status.pending - 1), lastError: reason });
}

// TS-206: what the header shows, worked out in one place (and unit tested). `unsavedCount` is how
// many fields on the page are unsaved right now -- typed and not yet left, or kept in their box
// after a failed save. While there are any, the header never says "All changes saved".
export type SaveStatusView =
  | { kind: "offline" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "saved" }
  | { kind: "none" };

export function saveStatusView(
  s: SaveStatus,
  { online = true, unsavedCount = 0 }: { online?: boolean; unsavedCount?: number } = {}
): SaveStatusView {
  if (!online) return { kind: "offline" };
  if (s.pending > 0) return { kind: "saving" };
  if (s.lastError) {
    // TS-177: no "Not saved:" in front of a message that already says what happened.
    const message = /^not saved\b|\bwas(n't| not) saved\b|\bwere saved\b/i.test(s.lastError)
      ? s.lastError
      : `Not saved: ${s.lastError}`;
    return { kind: "error", message };
  }
  if (s.lastSavedAt && unsavedCount === 0) return { kind: "saved" };
  return { kind: "none" };
}
