import type { WeddingDTO } from "@seatwise/shared";

// TS-246: the owner's wedding-settings boxes on the Collaborators tab. Since TS-235 the page's
// 4-second check brings in newer settings saved elsewhere (another tab, say) and moves the page's
// settings revision on. A box nobody is typing in takes the new value; a box with typing in it
// keeps it -- but its save then went out with the new revision, so it quietly overwrote the newer
// value saved elsewhere. Now such a box is remembered as "changed since you loaded it", and its
// save is refused the way the server refuses a stale one (the latest value is shown).

export type SettingsBoxKey =
  | "setting-name"
  | "setting-date"
  | "setting-venue"
  | "setting-side-1"
  | "setting-side-2"
  | "setting-note"
  | "setting-rsvp-cutoff";

/** What is in each settings box right now (as typed). */
export type SettingsBoxValues = Record<SettingsBoxKey, string>;

/** Each box's saved value in a wedding copy, as the box shows it. */
export function savedBoxValues(w: WeddingDTO): SettingsBoxValues {
  return {
    "setting-name": w.name,
    "setting-date": w.eventDate ?? "",
    "setting-venue": w.venueName ?? "",
    "setting-side-1": w.sideLabel1,
    "setting-side-2": w.sideLabel2,
    "setting-note": w.note ?? "",
    "setting-rsvp-cutoff": w.rsvpCutoffDate ?? "",
  };
}

/**
 * The boxes with typing in them (they differ from what `old` saved) whose own setting was changed
 * elsewhere (`fresh` saved something else) -- unless the typing is already the new value. A change
 * to any other setting (or to the email switch) doesn't count: only the same field.
 */
export function boxesChangedUnderneath(old: WeddingDTO, fresh: WeddingDTO, boxes: SettingsBoxValues): SettingsBoxKey[] {
  const was = savedBoxValues(old);
  const now = savedBoxValues(fresh);
  return (Object.keys(boxes) as SettingsBoxKey[]).filter(
    (key) => boxes[key] !== was[key] && now[key] !== was[key] && boxes[key] !== now[key]
  );
}

/**
 * TS-237: the email switch moves the settings revision on by one (so other tabs show it). The tab
 * that pressed it takes the new revision only when nothing else was saved in between (the answer
 * is exactly one past what this tab had) -- otherwise it keeps its own, so its next settings save
 * is refused as out of date (and shows the latest) rather than skipping a change made elsewhere.
 * Null: keep the revision this tab has.
 */
export function emailSwitchRevision(current: number, answered: number): number | null {
  return answered === current + 1 ? answered : null;
}

/**
 * TS-246 / TS-251: whether a box's save must be refused because its setting was saved elsewhere
 * while it had typing in it -- the box was flagged (see boxesChangedUnderneath) and the value about
 * to be saved isn't already the latest. The flags for `keys` are forgotten either way: the box
 * shows the latest from then on, so its next change is a fresh one. The RSVP cutoff's "Save
 * anyway" and "Change it" go through this too -- they used to skip it and leave the flag set.
 */
export function takeChangedFlags(
  flags: Set<SettingsBoxKey>,
  keys: SettingsBoxKey[],
  toSave: string,
  latest: string
): boolean {
  const hit = keys.some((k) => flags.has(k));
  for (const k of keys) flags.delete(k);
  return hit && toSave !== latest;
}

/** The same words the server uses when it refuses a stale settings save (409). */
export const SETTINGS_CHANGED_ELSEWHERE_MESSAGE =
  "This wedding's settings changed since you opened them (maybe in another tab) — showing the latest. Your change wasn't saved; make it again if it's still needed.";
