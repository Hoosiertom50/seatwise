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
 * Allow-list (`TabOrderException`): a known, accepted exception is written down where the check
 * is run, with its reason -- matched on the two stops' descriptions (role/tag plus accessible
 * name or label), never on a selector, so no selector leaves the page objects. Keep it short:
 * every entry is a place a keyboard user is sent somewhere unexpected.
 */

import type { Locator, Page } from "@playwright/test";

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

/** Describes and measures whatever has focus right now (null when nothing on the page does). */
async function focusedStop(page: Page, index: number): Promise<(TabStop & { key: string }) | null> {
  return page.evaluate((i) => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    // A stable identity for "already visited": the element's path from the document root.
    const path: number[] = [];
    for (let n: Element | null = el; n && n.parentElement; n = n.parentElement) {
      path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
    }
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
    return { index: i, description, left, top, width: rect.width, height: rect.height, pinned, key: path.join(".") };
  }, index);
}

/**
 * Focuses the first visible control on the page (or inside `region`), then presses Tab through
 * every control in turn and returns where each one was. The page should already be loaded and
 * settled. Stops when focus leaves the page or the region, or comes back to a control already seen.
 */
export async function walkTabOrder(page: Page, options: WalkOptions = {}): Promise<TabStop[]> {
  const maxStops = options.maxStops ?? DEFAULT_MAX_STOPS;
  const region = options.region ? await options.region.elementHandle() : null;
  const focusedFirst = await page.evaluate((root) => {
    window.scrollTo(0, 0);
    const scope: Element = root ?? document.body;
    const candidates = scope.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
    );
    for (const el of Array.from(candidates)) {
      if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled || el.closest("[inert]")) continue;
      if (el instanceof HTMLInputElement && el.type === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      el.focus();
      if (document.activeElement === el) return true;
    }
    return false;
  }, region);
  if (!focusedFirst) return [];

  const stops: TabStop[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < maxStops; i++) {
    if (i > 0) await page.keyboard.press("Tab");
    const stop = await focusedStop(page, i);
    if (!stop || seen.has(stop.key)) break; // left the page, or came round again
    if (region && !(await region.evaluate((r) => r.contains(document.activeElement)))) break; // left the region
    seen.add(stop.key);
    const { key: _key, ...rest } = stop;
    stops.push(rest);
  }
  await region?.dispose();
  return stops;
}

/** Walks the page's tab order and returns every reading-order problem (empty when fine). */
export async function checkTabOrder(page: Page, options: TabOrderOptions & WalkOptions = {}): Promise<{ stops: TabStop[]; problems: string[] }> {
  const stops = await walkTabOrder(page, options);
  return { stops, problems: tabOrderProblems(stops, options) };
}
