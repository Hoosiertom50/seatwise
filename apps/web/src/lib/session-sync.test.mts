// TS-229: unit tests for session-sync -- other open pages re-check their session as soon as one
// page signs in, or when shown again / focused. Run with `pnpm --filter @seatwise/web test`.
// Uses Node's real BroadcastChannel (pages in one browser share channels the same way) with
// stand-in window/document event targets.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  announceSignedIn,
  watchForSignIn,
  SESSION_CHANNEL,
  SIGNED_IN_MESSAGE,
  type SessionSyncEnv,
} from "./session-sync";

// Every channel a test opens is closed after it, even when an assertion fails first -- an open
// BroadcastChannel keeps the test process alive.
const openChannels: BroadcastChannel[] = [];
function channel(): BroadcastChannel {
  const c = new BroadcastChannel(SESSION_CHANNEL);
  openChannels.push(c);
  return c;
}
afterEach(() => {
  for (const c of openChannels.splice(0)) c.close();
});

function fakePage(): SessionSyncEnv & { window: EventTarget; document: EventTarget & { visibilityState: string } } {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  return {
    window: new EventTarget(),
    document: doc,
    openChannel: () => channel() as unknown as ReturnType<NonNullable<SessionSyncEnv["openChannel"]>>,
  };
}

// Waits until the condition holds (channel messages arrive on a later turn of the event loop),
// failing after 2 seconds rather than guessing a fixed delay.
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
// For "nothing happens": give a message time to arrive if one were sent.
const settle = () => new Promise((r) => setTimeout(r, 50));

test("another page signing in makes this page re-check at once", async () => {
  const page = fakePage();
  let checks = 0;
  const stop = watchForSignIn(async () => void checks++, page);
  announceSignedIn(fakePage());
  await until(() => checks === 1, "one re-check");
  await settle();
  assert.equal(checks, 1);
  stop();
});

test("unrelated channel messages are ignored", async () => {
  const page = fakePage();
  let checks = 0;
  const stop = watchForSignIn(async () => void checks++, page);
  const other = channel();
  other.postMessage("something-else");
  await settle();
  assert.equal(checks, 0);
  stop();
});

test("becoming visible or regaining focus re-checks; becoming hidden doesn't", async () => {
  const page = fakePage();
  let checks = 0;
  const stop = watchForSignIn(async () => void checks++, page);
  page.document.visibilityState = "hidden";
  page.document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.equal(checks, 0);
  page.document.visibilityState = "visible";
  page.document.dispatchEvent(new Event("visibilitychange"));
  await until(() => checks === 1, "re-check on visible");
  page.window.dispatchEvent(new Event("focus"));
  await until(() => checks === 2, "re-check on focus");
  stop();
});

test("a trigger during a running re-check queues exactly one more (a sign-in is never missed)", async () => {
  const page = fakePage();
  let checks = 0;
  let release: () => void = () => {};
  const stop = watchForSignIn(() => {
    checks++;
    return new Promise<void>((r) => (release = r));
  }, page);
  page.window.dispatchEvent(new Event("focus"));
  // While the first check is still out (e.g. sent before the cookie landed), several more triggers.
  announceSignedIn(fakePage());
  await settle();
  page.window.dispatchEvent(new Event("focus"));
  assert.equal(checks, 1);
  release();
  await until(() => checks === 2, "the one queued re-check");
  release();
  await settle();
  assert.equal(checks, 2);
  stop();
});

test("a failed re-check doesn't stop later ones", async () => {
  const page = fakePage();
  let checks = 0;
  const stop = watchForSignIn(async () => {
    checks++;
    throw new Error("401");
  }, page);
  page.window.dispatchEvent(new Event("focus"));
  await until(() => checks === 1, "first re-check");
  await settle();
  page.window.dispatchEvent(new Event("focus"));
  await until(() => checks === 2, "second re-check after a failure");
  stop();
});

test("after stopping, nothing triggers a re-check", async () => {
  const page = fakePage();
  let checks = 0;
  const stop = watchForSignIn(async () => void checks++, page);
  stop();
  announceSignedIn(fakePage());
  page.window.dispatchEvent(new Event("focus"));
  page.document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.equal(checks, 0);
});

test("the message is the agreed one, on the agreed channel", async () => {
  const listener = channel();
  const got: unknown[] = [];
  listener.onmessage = (e) => got.push(e.data);
  announceSignedIn(fakePage());
  await until(() => got.length === 1, "the message");
  assert.deepEqual(got, [SIGNED_IN_MESSAGE]);
  assert.equal(SESSION_CHANNEL, "seatwise-session");
});

test("without BroadcastChannel, announcing is a no-op and focus still re-checks", async () => {
  const page = { ...fakePage(), openChannel: null };
  let checks = 0;
  const stop = watchForSignIn(async () => void checks++, page);
  announceSignedIn(page);
  page.window.dispatchEvent(new Event("focus"));
  await until(() => checks === 1, "re-check on focus");
  stop();
});
