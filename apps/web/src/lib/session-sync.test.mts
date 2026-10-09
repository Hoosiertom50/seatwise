// TS-229: unit tests for session-sync -- other open pages re-check their session as soon as one
// page signs in, or when shown again / focused. Run with `pnpm --filter @seatwise/web test`.
// Uses Node's real BroadcastChannel (pages in one browser share channels the same way) with
// stand-in window/document event targets.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  announceSignedIn,
  watchForSignIn,
  SESSION_CHANNEL,
  SIGNED_IN_MESSAGE,
  type SessionSyncEnv,
} from "./session-sync";

function fakePage(): SessionSyncEnv & { window: EventTarget; document: EventTarget & { visibilityState: string } } {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  return {
    window: new EventTarget(),
    document: doc,
    openChannel: () => new BroadcastChannel(SESSION_CHANNEL) as unknown as ReturnType<NonNullable<SessionSyncEnv["openChannel"]>>,
  };
}

// Channel messages arrive on a later turn of the event loop.
const settle = () => new Promise((r) => setTimeout(r, 20));

test("another page signing in makes this page re-check at once", async () => {
  const page = fakePage();
  let checks = 0;
  const stop = watchForSignIn(async () => void checks++, page);
  announceSignedIn(fakePage());
  await settle();
  assert.equal(checks, 1);
  stop();
});

test("unrelated channel messages are ignored", async () => {
  const page = fakePage();
  let checks = 0;
  const stop = watchForSignIn(async () => void checks++, page);
  const other = new BroadcastChannel(SESSION_CHANNEL);
  other.postMessage("something-else");
  other.close();
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
  await settle();
  assert.equal(checks, 1);
  page.window.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(checks, 2);
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
  await settle();
  assert.equal(checks, 2);
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
  await settle();
  page.window.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(checks, 2);
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
  const listener = new BroadcastChannel(SESSION_CHANNEL);
  const got: unknown[] = [];
  listener.onmessage = (e) => got.push(e.data);
  announceSignedIn(fakePage());
  await settle();
  listener.close();
  assert.deepEqual(got, [SIGNED_IN_MESSAGE]);
  assert.equal(SESSION_CHANNEL, "seatwise-session");
});

test("without BroadcastChannel, announcing is a no-op and focus still re-checks", async () => {
  const page = { ...fakePage(), openChannel: null };
  let checks = 0;
  const stop = watchForSignIn(async () => void checks++, page);
  announceSignedIn(page);
  page.window.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(checks, 1);
  stop();
});
