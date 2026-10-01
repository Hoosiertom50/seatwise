// TS-128: unit tests for api-client's session-expired / session-restored events. Run with
// `pnpm --filter @seatwise/web test` (Node's built-in test runner via tsx -- no app server needed).
// `window` and `fetch` are stand-ins, so each response arrives exactly when the test says.
import { test } from "node:test";
import assert from "node:assert/strict";

const events: string[] = [];
const fakeWindow = new EventTarget();
(globalThis as { window?: unknown }).window = fakeWindow;

// Each fetch waits until the test answers it, so the order responses arrive in is under test control.
const pending: { path: string; respond: (status: number) => void }[] = [];
globalThis.fetch = ((path: string) =>
  new Promise<Response>((resolve) => {
    pending.push({
      path,
      respond: (status) => resolve(new Response(JSON.stringify(status === 200 ? {} : { error: "nope" }), { status })),
    });
  })) as typeof fetch;

const { api, SESSION_EXPIRED_EVENT, SESSION_RESTORED_EVENT } = await import("./api-client");
fakeWindow.addEventListener(SESSION_EXPIRED_EVENT, () => events.push("expired"));
fakeWindow.addEventListener(SESSION_RESTORED_EVENT, () => events.push("restored"));

const answer = async (path: string, status: number) => {
  const i = pending.findIndex((p) => p.path === path);
  assert.ok(i >= 0, `no request to ${path} is waiting`);
  pending.splice(i, 1)[0].respond(status);
  await new Promise((r) => setTimeout(r, 0));
};

test("a 401 sent before signing back in, but answered after, doesn't bring the notice back", async () => {
  // A working session, then it's lost.
  const first = api.get("/api/v1/weddings/w1");
  await answer("/api/v1/weddings/w1", 200);
  await first;
  const lost = api.get("/api/v1/weddings/w1/access").catch(() => {});
  await answer("/api/v1/weddings/w1/access", 401);
  await lost;
  assert.deepEqual(events, ["expired"]);

  // The 4-second access poll goes out still without a cookie...
  const stalePoll = api.get("/api/v1/weddings/w1/access").catch(() => {});
  // ...the planner signs in from the notice, and that succeeds first...
  const login = api.post("/api/v1/auth/login", { email: "a@example.invalid", password: "x" });
  await answer("/api/v1/auth/login", 200);
  await login;
  assert.deepEqual(events, ["expired", "restored"]);

  // ...then the old poll's 401 lands. It's about the lost session, so nothing changes.
  await answer("/api/v1/weddings/w1/access", 401);
  await stalePoll;
  assert.deepEqual(events, ["expired", "restored"]);
});

test("a 401 for a request sent after the restore still reports the session as expired", async () => {
  events.length = 0;
  const later = api.get("/api/v1/weddings/w1/access").catch(() => {});
  await answer("/api/v1/weddings/w1/access", 401);
  await later;
  assert.deepEqual(events, ["expired"]);
});
