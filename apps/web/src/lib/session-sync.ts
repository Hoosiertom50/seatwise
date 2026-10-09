// TS-229: lets every open Seatwise page notice a sign-in at once. Before this, a page showing the
// session-expired notice only found out the planner had signed in again (in another tab) on its
// next 4-second access poll -- or never, on pages without one. Now the page that signs in tells the
// others over a BroadcastChannel, and a page also re-checks whenever it's shown again or regains
// focus. Kept free of React and Next.js so it can be unit-tested (session-sync.test.mts).

export const SESSION_CHANNEL = "seatwise-session";
export const SIGNED_IN_MESSAGE = "signed-in";

type ChannelLike = {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
};

/** What the watcher needs from the browser -- passed in by tests, taken from the page otherwise. */
export type SessionSyncEnv = {
  window: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  document: Pick<EventTarget, "addEventListener" | "removeEventListener"> & { visibilityState: string };
  openChannel: (() => ChannelLike) | null;
};

function browserEnv(): SessionSyncEnv | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return {
    window,
    document,
    openChannel: typeof BroadcastChannel === "undefined" ? null : () => new BroadcastChannel(SESSION_CHANNEL),
  };
}

/** TS-229: tells every other open page that this one just signed in. */
export function announceSignedIn(env: SessionSyncEnv | null = browserEnv()): void {
  if (!env?.openChannel) return;
  try {
    const channel = env.openChannel();
    // Messages already posted are still delivered after close().
    channel.postMessage(SIGNED_IN_MESSAGE);
    channel.close();
  } catch {
    // No channel (an old browser, a locked-down context) -- other pages still re-check on focus.
  }
}

/**
 * TS-229: calls `recheck` right away when another page signs in, when this page is shown again, or
 * when it regains focus. Only one re-check runs at a time; a trigger that arrives while one is
 * running queues exactly one more, so a sign-in announced mid-check is never missed. Returns a
 * function that stops watching.
 */
export function watchForSignIn(
  recheck: () => Promise<unknown>,
  env: SessionSyncEnv | null = browserEnv()
): () => void {
  if (!env) return () => {};
  let stopped = false;
  let running = false;
  let again = false;

  const run = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await recheck().catch(() => {});
      } while (again && !stopped);
    } finally {
      running = false;
    }
  };

  const onMessage = (e: MessageEvent) => {
    if (e.data === SIGNED_IN_MESSAGE) void run();
  };
  const onVisible = () => {
    if (env.document.visibilityState === "visible") void run();
  };
  const onFocus = () => void run();

  let channel: ChannelLike | null = null;
  try {
    channel = env.openChannel ? env.openChannel() : null;
    channel?.addEventListener("message", onMessage);
  } catch {
    channel = null;
  }
  env.document.addEventListener("visibilitychange", onVisible);
  env.window.addEventListener("focus", onFocus);

  return () => {
    stopped = true;
    channel?.removeEventListener("message", onMessage);
    channel?.close();
    env.document.removeEventListener("visibilitychange", onVisible);
    env.window.removeEventListener("focus", onFocus);
  };
}
