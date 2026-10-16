// Review 16 (PR #116 CI): focusIfLost with a stand-in document -- the latest call wins. Generate's
// focus check was still going when the Restore preview's Cancel asked for Restore, and on a slow
// machine Generate got the focus (a flaky CI test on Edge, then WebKit).
import { test } from "node:test";
import assert from "node:assert/strict";

type El = { id: string; isConnected: boolean; disabled?: boolean; focus: () => void };
const body: El = { id: "body", isConnected: true, focus: () => undefined };
const elements = new Map<string, El>();
const doc = {
  activeElement: body as El | null,
  body,
  getElementById: (id: string) => elements.get(id) ?? null,
};
function element(id: string): El {
  const el: El = { id, isConnected: true, focus: () => (doc.activeElement = el) };
  elements.set(id, el);
  return el;
}
(globalThis as unknown as { document: typeof doc }).document = doc;
const { focusIfLost } = await import("./focus-if-lost");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Review 16: the latest call wins over one still looking", async () => {
  const generate = element("generate");
  doc.activeElement = body;
  focusIfLost("generate");
  await wait(20);
  assert.equal(doc.activeElement, generate);
  // The planner moves on; focus drops to the page (the preview's Cancel goes away), and Restore is
  // asked for -- but it comes back a moment later than Generate's next check.
  doc.activeElement = body;
  focusIfLost("restore");
  await wait(80);
  const restore = element("restore");
  await wait(300);
  assert.equal(doc.activeElement, restore);
});

test("a control that comes back late still gets focus, and a deliberate move elsewhere is kept", async () => {
  elements.clear();
  doc.activeElement = body;
  focusIfLost("late");
  await wait(400);
  const late = element("late");
  await wait(120);
  assert.equal(doc.activeElement, late);
  const other = element("other");
  other.focus();
  await wait(300);
  assert.equal(doc.activeElement, other);
});
