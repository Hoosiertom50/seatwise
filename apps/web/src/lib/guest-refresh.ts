// TS-207: the wedding page loads the guest list once, and nothing used to load it again -- RSVP
// answers, a walk-in added on another phone, another planner's edits or an import never showed
// until a reload. The page now fetches the list again every few seconds (and when a tab that uses
// it opens) and merges what comes back into what's on screen with this. Pure, so it's unit-tested.

/** The fields the merge needs -- GuestDTO has them. */
export interface RevisionedGuest {
  id: string;
  revision: number;
}

export interface GuestMergeOptions<G> {
  /** The ids on screen when the fetch was sent. A guest missing from the answer is only taken off
   * if it was there then (otherwise it was added on this screen while the fetch was out); a guest
   * in the answer but no longer on screen is only put back if it wasn't there then (otherwise it
   * was deleted on this screen meanwhile). */
  idsAtFetchStart: ReadonlySet<string>;
  /** Guests never changed by a refresh -- e.g. the row whose box is being typed in. */
  protectedIds?: ReadonlySet<string>;
  /** Where a guest new to this screen goes; defaults to the end. */
  compare?: (a: G, b: G) => number;
}

/**
 * Merges a freshly fetched guest list into the one on screen, guest by guest:
 * - a guest whose fetched copy has a higher revision takes it (never an older or equal copy, so a
 *   save made here while the fetch was out is kept);
 * - a protected guest is left exactly as it is;
 * - a guest added elsewhere is added; a guest deleted elsewhere is taken off (see idsAtFetchStart).
 * Returns the same array when nothing changed, so React skips the re-render.
 */
export function mergeRefreshedGuests<G extends RevisionedGuest>(
  current: readonly G[],
  fetched: readonly G[],
  { idsAtFetchStart, protectedIds = new Set(), compare }: GuestMergeOptions<G>
): G[] {
  const fetchedById = new Map(fetched.map((g) => [g.id, g]));
  const currentIds = new Set(current.map((g) => g.id));
  let changed = false;
  const out: G[] = [];
  for (const local of current) {
    const fresh = fetchedById.get(local.id);
    if (!fresh) {
      // Deleted elsewhere -- unless it was added here after the fetch went out, or is protected.
      if (idsAtFetchStart.has(local.id) && !protectedIds.has(local.id)) {
        changed = true;
        continue;
      }
      out.push(local);
      continue;
    }
    if (!protectedIds.has(local.id) && fresh.revision > local.revision) {
      out.push(fresh);
      changed = true;
    } else out.push(local);
  }
  const added = fetched.filter((g) => !currentIds.has(g.id) && !idsAtFetchStart.has(g.id));
  if (added.length > 0) {
    changed = true;
    out.push(...added);
    if (compare) out.sort(compare);
  }
  return changed ? out : (current as G[]);
}

/**
 * The guest a focused box belongs to, from its id -- the Guests tab names a row's boxes
 * `guest-<guestId>-<field>` (e.g. `guest-abc123-firstName`). Null for anything else.
 */
export function guestIdFromFieldId(elementId: string | null | undefined): string | null {
  const match = /^guest-(.+)-[A-Za-z]+$/.exec(elementId ?? "");
  return match ? match[1] : null;
}
