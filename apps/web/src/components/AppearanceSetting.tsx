"use client";

import { useSyncExternalStore } from "react";
import {
  APPEARANCE_CHOICES,
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  readAppearance,
  saveAppearance,
  type Appearance,
} from "@/lib/appearance";

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// The saved choice, read straight from this browser's storage. A change in this tab tells the
// listeners itself; a change in another tab arrives as a "storage" event.
const sameTabListeners = new Set<() => void>();
function subscribe(onChange: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === APPEARANCE_STORAGE_KEY || e.key === null) onChange();
  };
  sameTabListeners.add(onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    sameTabListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}
const currentChoice = () => readAppearance(browserStorage());
const choiceBeforeLoad = (): Appearance => "system";

// TS-257: Light, Dark or Match my device -- applied at once, kept in this browser only.
export function AppearanceSetting() {
  const choice = useSyncExternalStore(subscribe, currentChoice, choiceBeforeLoad);

  function onChange(value: Appearance) {
    saveAppearance(browserStorage(), value);
    applyAppearance(document.documentElement, value);
    sameTabListeners.forEach((l) => l());
  }

  return (
    <section aria-labelledby="appearance" className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
      <h2 id="appearance" className="mb-1 text-lg font-medium">
        Appearance
      </h2>
      <fieldset>
        <legend className="mb-3 text-sm text-neutral-600 dark:text-neutral-300">
          Choose light or dark, or let Seatwise match your device. This is saved on this device and
          browser only.
        </legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {APPEARANCE_CHOICES.map((c) => (
            <label key={c.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="appearance"
                value={c.value}
                checked={choice === c.value}
                onChange={() => onChange(c.value)}
              />
              {c.label}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
