// TS-257: light or dark, chosen in the app ("Appearance" on the account page) instead of always
// following the device. The choice is kept in this browser only (localStorage), so a phone and a
// laptop can differ, and nothing is sent to the server. "system" -- no choice saved -- is today's
// behaviour: the page follows the device. The choice shows as data-theme="light" / "dark" on
// <html>; globals.css points Tailwind's `dark:` variant and the page colours at it.

export type Appearance = "system" | "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "seatwise-appearance";

export const APPEARANCE_CHOICES: { value: Appearance; label: string }[] = [
  { value: "system", label: "Match my device" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function parseAppearance(stored: string | null | undefined): Appearance {
  return stored === "light" || stored === "dark" ? stored : "system";
}

// Storage can be missing or throw (a private window, blocked site data) -- then it's "system".
export function readAppearance(storage: StorageLike | null | undefined): Appearance {
  try {
    return parseAppearance(storage?.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function saveAppearance(storage: StorageLike | null | undefined, value: Appearance): void {
  try {
    if (value === "system") storage?.removeItem(APPEARANCE_STORAGE_KEY);
    else storage?.setItem(APPEARANCE_STORAGE_KEY, value);
  } catch {
    // Not saved, but still applied to this page.
  }
}

export function applyAppearance(root: { dataset: DOMStringMap }, value: Appearance): void {
  if (value === "system") delete root.dataset.theme;
  else root.dataset.theme = value;
}

// Runs in <head> before the page is drawn, so a saved choice never flashes the other theme first.
// It also keeps every open tab in step: a change saved in one tab arrives as a "storage" event.
export const APPEARANCE_BOOT_SCRIPT = `(function(){var k=${JSON.stringify(APPEARANCE_STORAGE_KEY)};function a(v){var r=document.documentElement;if(v==="light"||v==="dark")r.setAttribute("data-theme",v);else r.removeAttribute("data-theme");}try{a(localStorage.getItem(k));}catch(e){}window.addEventListener("storage",function(e){if(e.key===k||e.key===null)a(e.newValue);});})();`;
