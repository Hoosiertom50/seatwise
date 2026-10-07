// TS-206: unit tests for the unsaved-changes bookkeeping and the header's save wording.
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UnsavedRegistry, couldntSaveNote } from "./unsaved-registry";
import { saveStatusView, saveStatusStore, writeStarted, writeSucceeded, writeFailed } from "./save-status";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a save on its way isn't 'unsaved' (a tab click doesn't ask), but it is 'saving'", async () => {
  const r = new UnsavedRegistry();
  const save = deferred<boolean>();
  void r.trackSave("guest-row-g1-email", save.promise);
  assert.equal(r.hasUnsaved(), false);
  assert.equal(r.isSaving(), true);
  save.resolve(true);
  assert.equal(await r.waitForSaves(), true);
  assert.equal(r.isSaving(), false);
});

test("waitForSaves is false when any save failed, and waits for all of them", async () => {
  const r = new UnsavedRegistry();
  const a = deferred<boolean>();
  const b = deferred<void>();
  void r.trackSave("a", a.promise);
  void r.trackSave("b", b.promise);
  const waiting = r.waitForSaves();
  let settled = false;
  void waiting.then(() => (settled = true));
  a.resolve(false);
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(settled, false, "still waiting for b");
  b.resolve();
  assert.equal(await waiting, false);
  assert.equal(r.isSaving(), false);
});

test("a save that throws counts as not saved", async () => {
  const r = new UnsavedRegistry();
  void r.trackSave("x", Promise.reject(new Error("offline")));
  assert.equal(await r.waitForSaves(), false);
});

test("nothing saving: waitForSaves answers true straight away", async () => {
  assert.equal(await new UnsavedRegistry().waitForSaves(), true);
});

test("dirty marks count, clear, and tell listeners only on a real change", () => {
  const r = new UnsavedRegistry();
  let calls = 0;
  r.subscribe(() => calls++);
  r.setDirty("k", true);
  r.setDirty("k", true);
  assert.equal(r.dirtyCount(), 1);
  assert.equal(calls, 1);
  r.clearDirty();
  assert.equal(r.hasUnsaved(), false);
  assert.equal(calls, 2);
});

test("notes: the same failure shows once, and Dismiss removes it", () => {
  const r = new UnsavedRegistry();
  const text = couldntSaveNote("Jane Smith's email", "Enter a valid email address.");
  assert.equal(text, "Couldn't save Jane Smith's email: Enter a valid email address.");
  r.addNote(text);
  r.addNote(text);
  assert.equal(r.notes().length, 1);
  r.dismissNote(r.notes()[0].id);
  assert.equal(r.notes().length, 0);
  // A note never makes the page "unsaved" -- no phantom "leave and lose them?" question.
  assert.equal(r.hasUnsaved(), false);
});

test("header: 'All changes saved' only when nothing on the page is unsaved", () => {
  const base = { pending: 0, lastError: null, lastSavedAt: 1 };
  assert.equal(saveStatusView(base).kind, "saved");
  assert.equal(saveStatusView(base, { unsavedCount: 1 }).kind, "none");
  assert.equal(saveStatusView({ ...base, pending: 1 }).kind, "saving");
  assert.equal(saveStatusView(base, { online: false }).kind, "offline");
  const failed = saveStatusView({ ...base, lastError: "Enter a valid email address." });
  assert.deepEqual(failed, { kind: "error", message: "Not saved: Enter a valid email address." });
});

test("header: after Dismiss it shows nothing, not 'saved'", () => {
  saveStatusStore.resetHistory();
  writeStarted();
  writeSucceeded();
  writeStarted();
  writeFailed("Enter a valid email address.");
  assert.equal(saveStatusView(saveStatusStore.getSnapshot()).kind, "error");
  saveStatusStore.dismissError();
  assert.equal(saveStatusView(saveStatusStore.getSnapshot()).kind, "none");
  // A later save that works may say saved -- unless a field is still kept unsaved.
  writeStarted();
  writeSucceeded();
  assert.equal(saveStatusView(saveStatusStore.getSnapshot(), { unsavedCount: 1 }).kind, "none");
  assert.equal(saveStatusView(saveStatusStore.getSnapshot()).kind, "saved");
});
