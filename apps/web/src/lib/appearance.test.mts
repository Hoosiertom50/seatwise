// TS-257: unit tests for the Appearance setting's saved choice. The page itself is covered by
// e2e/tests/account-management.appearance-light-dark-or-device.spec.ts.
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const { APPEARANCE_BOOT_SCRIPT, APPEARANCE_STORAGE_KEY, applyAppearance, parseAppearance, readAppearance, saveAppearance } =
  await import("./appearance");

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

test("TS-257: only 'light' and 'dark' are kept; anything else means match the device", () => {
  assert.equal(parseAppearance("light"), "light");
  assert.equal(parseAppearance("dark"), "dark");
  for (const v of [null, undefined, "", "system", "DARK", "blue"]) assert.equal(parseAppearance(v), "system");
});

test("TS-257: saving Light or Dark stores it; Match my device clears it", () => {
  const storage = memoryStorage();
  saveAppearance(storage, "dark");
  assert.equal(storage.data.get(APPEARANCE_STORAGE_KEY), "dark");
  assert.equal(readAppearance(storage), "dark");
  saveAppearance(storage, "system");
  assert.equal(storage.data.has(APPEARANCE_STORAGE_KEY), false);
  assert.equal(readAppearance(storage), "system");
});

test("TS-257: storage that's missing or refuses (private window) never breaks the page", () => {
  const refusing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readAppearance(refusing), "system");
  assert.equal(readAppearance(null), "system");
  assert.equal(saveAppearance(refusing, "dark"), false);
  assert.equal(saveAppearance(null, "dark"), false);
  assert.equal(saveAppearance(memoryStorage(), "dark"), true);
});

test("TS-257: the choice is shown as data-theme on <html>, and none for match the device", () => {
  const root = { dataset: {} as DOMStringMap };
  applyAppearance(root, "light");
  assert.equal(root.dataset.theme, "light");
  applyAppearance(root, "system");
  assert.equal(root.dataset.theme, undefined);
});

test("TS-257: the boot script uses the same storage key as the setting", () => {
  assert.ok(APPEARANCE_BOOT_SCRIPT.includes(`var k=${JSON.stringify(APPEARANCE_STORAGE_KEY)};`));
});

test("TS-257: the boot script applies a saved choice before the page is drawn and follows other tabs", () => {
  const attrs = new Map<string, string>();
  const listeners: ((e: { key: string | null; newValue: string | null }) => void)[] = [];
  const sandbox = {
    document: {
      documentElement: {
        setAttribute: (k: string, v: string) => void attrs.set(k, v),
        removeAttribute: (k: string) => void attrs.delete(k),
      },
    },
    localStorage: memoryStorage({ [APPEARANCE_STORAGE_KEY]: "dark" }),
    window: { addEventListener: (_: string, fn: (typeof listeners)[number]) => void listeners.push(fn) },
  };
  vm.runInNewContext(APPEARANCE_BOOT_SCRIPT, sandbox);
  assert.equal(attrs.get("data-theme"), "dark");
  listeners[0]({ key: APPEARANCE_STORAGE_KEY, newValue: "light" });
  assert.equal(attrs.get("data-theme"), "light");
  listeners[0]({ key: APPEARANCE_STORAGE_KEY, newValue: null });
  assert.equal(attrs.has("data-theme"), false);
  listeners[0]({ key: "something-else", newValue: "dark" });
  assert.equal(attrs.has("data-theme"), false);
});
