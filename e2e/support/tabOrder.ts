/**
 * TS-193 — checks that pressing Tab moves through a page in the order a person reads it: each
 * step goes to the right on the same line, or further down the page. Never back up, and never
 * back to the left on the same line.
 *
 * How it works (`walkTabOrder`): focus the first visible control on the page (or inside a given
 * region), then press Tab again and again, recording each focused control's position, until focus
 * leaves the page/region, comes back round to a control already seen, or `maxStops` is reached.
 * Positions are measured in the page's own layout -- the page's scroll and any sideways-scrolling
 * box (the wedding tab bar at phone width) are added back -- so a box scrolling to show the
 * focused control doesn't make that control look as if it moved left or up.
 *
 * The rules (`tabOrderProblems`, kept pure so it is unit-tested without a browser):
 *   - "Same line": the two controls' vertical extents overlap by at least half the shorter one,
 *     or their tops are within `lineTolerancePx` (default 8px). On the same line the next control
 *     must not be to the left.
 *   - Otherwise the next control must be lower: its top below the previous control's top.
 *   - Controls inside a sticky or fixed container (a sticky header, a pinned bar) are allowed as
 *     the first stops -- they stay put while the page scrolls, so their page position means
 *     nothing. A sticky/fixed control met later in the walk is reported, unless allow-listed.
 *   - Invisible controls (zero size, e.g. a visually hidden skip link) are skipped.
 *
 * TS-200: the walk itself is checked too (`tabWalkProblems`). It must end cleanly -- by leaving
 * the page or region, or coming back to its first control -- not by giving up at `maxStops`, by
 * focus dropping to the page part-way, or by going round in a loop; otherwise it didn't see
 * everything. And it must stop on exactly the visible controls in the walked page or region
 * (disabled, hidden, inert and tabindex="-1" ones aren't counted; a radio group counts once): a
 * control Tab skips can't be used from the keyboard, and a stop that isn't a control (a box that
 * only scrolls) is a wasted step. Known exceptions go in a `TabCountException` list, each with its
 * reason -- same rules as the allow-list below.
 *
 * Allow-list (`TabOrderException`): a known, accepted exception is written down where the check
 * is run, with its reason -- matched on the two stops' descriptions (role/tag plus accessible
 * name or label), never on a selector, so no selector leaves the page objects. Keep it short:
 * every entry is a place a keyboard user is sent somewhere unexpected.
 */

import type { ElementHandle, Locator, Page } from "@playwright/test";

export interface TabStop {
  /** 0-based position in the walk. */
  index: number;
  /** e.g. `button "Add guest"`, `input#guest-first-name "First name"`. */
  description: string;
  /** Position in the page's own layout (scroll added back), in CSS pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Inside a `position: sticky` or `position: fixed` container. */
  pinned: boolean;
}

export interface TabOrderException {
  /** Matches the description of the stop Tab moves *from*. */
  from: RegExp;
  /** Matches the description of the stop Tab moves *to*. */
  to: RegExp;
  /** Why this is acceptable -- required, and shown in the report. */
  reason: string;
}

export interface TabOrderOptions {
  /** Vertical slack for "same line", in px. */
  lineTolerancePx?: number;
  /** Known, accepted exceptions (see the header comment). */
  allow?: readonly TabOrderException[];
}

export interface WalkOptions {
  /** Most stops to record before giving up (a page with many rows). */
  maxStops?: number;
  /** Only walk the controls inside this part of the page (from a page object). Default: the whole page. */
  region?: Locator;
}

const DEFAULT_LINE_TOLERANCE_PX = 8;
const DEFAULT_MAX_STOPS = 250;

function sameLine(a: TabStop, b: TabStop, tolerance: number): boolean {
  if (Math.abs(a.top - b.top) <= tolerance) return true;
  const overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return overlap >= Math.min(a.height, b.height) / 2;
}

/** Every step that breaks the reading-order rule, as one readable line each (empty when fine). */
export function tabOrderProblems(stops: readonly TabStop[], options: TabOrderOptions = {}): string[] {
  const tolerance = options.lineTolerancePx ?? DEFAULT_LINE_TOLERANCE_PX;
  const allow = options.allow ?? [];
  const problems: string[] = [];
  const visible = stops.filter((s) => s.width > 0 && s.height > 0);

  // Leading pinned stops (a sticky header or tab bar) are fine wherever they sit.
  let start = 0;
  while (start < visible.length && visible[start].pinned) start++;

  const allowed = (from: TabStop, to: TabStop) => allow.some((e) => e.from.test(from.description) && e.to.test(to.description));
  for (let i = start + 1; i < visible.length; i++) {
    const prev = visible[i - 1];
    const cur = visible[i];
    if (allowed(prev, cur)) continue;
    const step = `Tab ${prev.index + 1}->${cur.index + 1}: ${prev.description} (${Math.round(prev.left)},${Math.round(prev.top)}) -> ${cur.description} (${Math.round(cur.left)},${Math.round(cur.top)})`;
    if (cur.pinned) {
      problems.push(`${step} goes to a pinned (sticky/fixed) control after the page content`);
    } else if (sameLine(prev, cur, tolerance)) {
      if (cur.left + tolerance < prev.left) problems.push(`${step} goes back to the left on the same line`);
    } else if (cur.top < prev.top) {
      problems.push(`${step} goes back up the page`);
    }
  }
  return problems;
}

/**
 * TS-200: how a walk ended. Only the first three are a clean end -- the walk saw every control:
 *   - "left-region": Tab moved focus out of the region being walked;
 *   - "came-round": Tab came back to the first control of the walk;
 *   - "left-page": Tab moved focus off the page (to the browser), or round to the page's start;
 *   - "trapped": Tab came back to a control in the middle of the walk, not the first one;
 *   - "lost-focus": focus fell to the page itself part-way through, and the next Tab went on to a
 *     control not yet seen (a control removed from under the focus, say);
 *   - "max-stops": the walk gave up after `maxStops` stops;
 *   - "nothing-focusable": there was no control to start from.
 */
export type TabWalkEnd = "left-region" | "came-round" | "left-page" | "trapped" | "lost-focus" | "max-stops" | "nothing-focusable";

/** TS-200: everything one walk found (see walkTabOrderDetailed). */
export interface TabWalk {
  stops: TabStop[];
  end: TabWalkEnd;
  maxStops: number;
  /** How many visible controls Tab should reach in the walked page or region (a radio group counts once). */
  focusableCount: number;
  /** Visible controls that were counted but Tab never reached. */
  unreached: string[];
  /** Visible stops Tab reached that weren't counted (e.g. a box that only scrolls). */
  uncounted: string[];
}

/**
 * TS-200: a control allowed to be missed by Tab, or reached without being counted -- matched on
 * its description, with the reason it's acceptable. Same spirit as TabOrderException: short, and
 * each entry agreed.
 */
export interface TabCountException {
  matches: RegExp;
  reason: string;
}

/**
 * TS-200: whether the walk itself can be trusted (empty when it can). A walk that gave up at
 * `maxStops`, or lost focus part-way, or went round in a loop, didn't see the whole page -- so
 * "no reading-order problems" from it would mean nothing. And Tab must reach exactly the visible
 * controls there are: one it skips can't be used from the keyboard at all. Pure, so it is
 * unit-tested without a browser.
 */
export function tabWalkProblems(walk: TabWalk, allow: readonly TabCountException[] = []): string[] {
  const problems: string[] = [];
  const excused = (description: string) => allow.some((e) => e.matches.test(description));
  if (walk.end === "max-stops") problems.push(`the walk gave up after ${walk.maxStops} stops without leaving the page -- raise maxStops or walk a smaller region`);
  if (walk.end === "lost-focus") problems.push(`focus fell to the page itself after stop ${walk.stops.length}, and Tab then went on to a control not yet seen`);
  if (walk.end === "trapped") problems.push(`Tab came back to a control in the middle of the walk (after stop ${walk.stops.length}) instead of moving on`);
  if (walk.end === "nothing-focusable") problems.push("there was no control to start the walk from");
  const unreached = walk.unreached.filter((d) => !excused(d));
  const uncounted = walk.uncounted.filter((d) => !excused(d));
  for (const d of unreached) problems.push(`Tab never reached ${d}`);
  for (const d of uncounted) problems.push(`Tab stopped on ${d}, which isn't a control`);
  const visibleStops = walk.stops.filter((s) => s.width > 0 && s.height > 0).length;
  const expected = walk.focusableCount - (walk.unreached.length - unreached.length) + (walk.uncounted.length - uncounted.length);
  if (problems.length === 0 && visibleStops !== expected) {
    problems.push(`Tab made ${visibleStops} visible stops, but there are ${expected} visible controls`);
  }
  return problems;
}

/** Describes and measures whatever has focus right now (null when nothing on the page does). */
async function focusedStop(page: Page, index: number): Promise<(TabStop & { key: string; countKey: string }) | null> {
  return page.evaluate((i) => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    // A stable identity for each control: a tag set the first time it's seen (its position in the
    // page shifts when the tab finishes loading or a notice appears, so positions don't match up).
    const pathOf = (e: Element) => {
      const w = window as unknown as { __tabWalkId?: number };
      const el = e as HTMLElement;
      if (!el.dataset.tabWalkId) el.dataset.tabWalkId = String((w.__tabWalkId = (w.__tabWalkId ?? 0) + 1));
      return el.dataset.tabWalkId;
    };
    const key = pathOf(el);
    // TS-200: a radio group is one Tab stop, whichever of its radios has focus.
    const countKey =
      el instanceof HTMLInputElement && el.type === "radio" && el.name
        ? `radio:${el.form ? pathOf(el.form) : ""}:${el.name}`
        : key;
    const rect = el.getBoundingClientRect();
    let left = rect.left + window.scrollX;
    let top = rect.top + window.scrollY;
    let pinned = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.position === "sticky" || style.position === "fixed") pinned = true;
      left += p.scrollLeft;
      top += p.scrollTop;
    }
    if (getComputedStyle(el).position === "fixed") pinned = true;
    const name =
      el.getAttribute("aria-label") ??
      (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : null) ??
      el.closest("label")?.textContent ??
      el.getAttribute("placeholder") ??
      el.textContent ??
      "";
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const description = `${role}${el.id ? `#${el.id}` : ""} "${name.replace(/\s+/g, " ").trim().slice(0, 60)}"`;
    return { index: i, description, left, top, width: rect.width, height: rect.height, pinned, key, countKey };
  }, index);
}

/**
 * TS-200: every visible control Tab should reach in `root` (the whole page when null), each with
 * the same identity focusedStop gives it -- a radio group once. Disabled, hidden, zero-size,
 * inert and tabindex="-1" controls aren't counted.
 */
async function visibleControls(page: Page, root: ElementHandle<Element> | null): Promise<{ countKey: string; description: string }[]> {
  return page.evaluate((r) => {
    const scope: Element = r ?? document.body;
    // A stable identity for each control: a tag set the first time it's seen (its position in the
    // page shifts when the tab finishes loading or a notice appears, so positions don't match up).
    const pathOf = (e: Element) => {
      const w = window as unknown as { __tabWalkId?: number };
      const el = e as HTMLElement;
      if (!el.dataset.tabWalkId) el.dataset.tabWalkId = String((w.__tabWalkId = (w.__tabWalkId ?? 0) + 1));
      return el.dataset.tabWalkId;
    };
    const found = new Map<string, string>();
    const candidates = scope.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
    );
    for (const el of Array.from(candidates)) {
      if (el.tabIndex < 0 || el.matches(":disabled") || el.closest("[inert]")) continue;
      // TS-200: inside a folded-shut <details> (other than its own summary) a control can't be
      // reached until it's unfolded -- it isn't one of the page's controls yet.
      const folded = el.closest("details:not([open])");
      if (folded && !el.closest("summary")) continue;
      if (el instanceof HTMLInputElement && el.type === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const countKey =
        el instanceof HTMLInputElement && el.type === "radio" && el.name
          ? `radio:${el.form ? pathOf(el.form) : ""}:${el.name}`
          : pathOf(el);
      if (found.has(countKey)) continue;
      const name = el.getAttribute("aria-label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : null) ?? el.textContent ?? "";
      const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
      found.set(countKey, `${role}${el.id ? `#${el.id}` : ""} "${name.replace(/\s+/g, " ").trim().slice(0, 60)}"`);
    }
    return Array.from(found, ([countKey, description]) => ({ countKey, description }));
  }, root);
}

/**
 * Focuses the first visible control on the page (or inside `region`), then presses Tab through
 * every control in turn and records where each one was. The page should already be loaded and
 * settled. Stops when focus leaves the page or the region, or comes back to a control already
 * seen; TS-200: says which (`end`), and compares the stops with the visible controls there are.
 */
export async function walkTabOrderDetailed(page: Page, options: WalkOptions = {}): Promise<TabWalk> {
  const maxStops = options.maxStops ?? DEFAULT_MAX_STOPS;
  // TS-200: the walk and the count must see the same page -- wait until it has finished loading
  // (some controls stay switched off until their data arrives).
  await page.waitForLoadState("networkidle");
  const region = options.region ? await options.region.elementHandle() : null;
  const focusedFirst = await page.evaluate((root) => {
    window.scrollTo(0, 0);
    const scope: Element = root ?? document.body;
    const candidates = scope.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
    );
    for (const el of Array.from(candidates)) {
      if (el.tabIndex < 0 || el.matches(":disabled") || el.closest("[inert]")) continue;
      // TS-200: inside a folded-shut <details> (other than its own summary) a control can't be
      // reached until it's unfolded -- it isn't one of the page's controls yet.
      const folded = el.closest("details:not([open])");
      if (folded && !el.closest("summary")) continue;
      if (el instanceof HTMLInputElement && el.type === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      el.focus();
      if (document.activeElement === el) return true;
    }
    return false;
  }, region);

  const stops: TabStop[] = [];
  const reached = new Map<string, string>();
  let end: TabWalkEnd = "max-stops";
  if (!focusedFirst) {
    end = "nothing-focusable";
  } else {
    const seen = new Set<string>();
    let firstKey = "";
    let previousKey = "";
    for (let i = 0; i < maxStops; i++) {
      if (i > 0) await page.keyboard.press("Tab");
      let stop = await focusedStop(page, i);
      if (!stop) {
        // Focus is on the page itself: either Tab took it off the page (the browser's own controls,
        // or round to the page's start), or it was dropped part-way. Tab on past any invisible
        // controls at the very start (a skip link) to see where it goes next.
        for (let extra = 0; extra < 5; extra++) {
          await page.keyboard.press("Tab");
          stop = await focusedStop(page, i);
          if (!stop || stop.width > 0 || stop.height > 0) break;
        }
        end = !stop || seen.has(stop.key) ? "left-page" : "lost-focus";
        break;
      }
      // A date or time box keeps focus while Tab moves through its parts (month, day, year), so the
      // same control again straight after itself is still that one stop, not a loop.
      if (stop.key === previousKey) continue;
      if (seen.has(stop.key)) {
        end = stop.key === firstKey ? "came-round" : "trapped";
        break;
      }
      if (region && !(await region.evaluate((r) => r.contains(document.activeElement)))) {
        end = "left-region";
        break;
      }
      if (i === 0) firstKey = stop.key;
      previousKey = stop.key;
      seen.add(stop.key);
      const { key: _key, countKey, ...rest } = stop;
      stops.push(rest);
      if (rest.width > 0 && rest.height > 0) reached.set(countKey, rest.description);
    }
  }
  // TS-200: counted after the walk, once the page has settled (see pathOf).
  const controls = await visibleControls(page, region);
  await region?.dispose();

  const counted = new Set(controls.map((c) => c.countKey));
  return {
    stops,
    end,
    maxStops,
    focusableCount: controls.length,
    unreached: controls.filter((c) => !reached.has(c.countKey)).map((c) => c.description),
    uncounted: Array.from(reached).filter(([k]) => !counted.has(k)).map(([, d]) => d),
  };
}

/** The stops of a walk (see walkTabOrderDetailed). */
export async function walkTabOrder(page: Page, options: WalkOptions = {}): Promise<TabStop[]> {
  return (await walkTabOrderDetailed(page, options)).stops;
}

/**
 * Walks the page's tab order and returns every reading-order problem (empty when fine). TS-200:
 * `walkProblems` says whether the walk itself can be trusted (see tabWalkProblems).
 */
export async function checkTabOrder(
  page: Page,
  options: TabOrderOptions & WalkOptions & { allowCount?: readonly TabCountException[] } = {},
): Promise<{ stops: TabStop[]; problems: string[]; walk: TabWalk; walkProblems: string[] }> {
  // TS-200: a tab still drawing its data can be walked before its controls are in place (they
  // arrive, or switch on, a moment later). A real problem shows on every walk; one that only shows
  // on a page that had not settled does not -- so the walk is tried up to three times, a moment apart.
  let walk = await walkTabOrderDetailed(page, options);
  let walkProblems = tabWalkProblems(walk, options.allowCount);
  for (let attempt = 1; attempt < 3 && walkProblems.length > 0; attempt++) {
    await page.waitForTimeout(750);
    walk = await walkTabOrderDetailed(page, options);
    walkProblems = tabWalkProblems(walk, options.allowCount);
  }
  return { stops: walk.stops, problems: tabOrderProblems(walk.stops, options), walk, walkProblems };
}
