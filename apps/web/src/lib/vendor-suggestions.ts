import type { VendorSuggestionDTO } from "@seatwise/shared";

// TS-97: which of the planner's past vendors "Add a vendor" offers for what they've typed so far.

/** How many suggestions show at once. */
export const MAX_VENDOR_SUGGESTIONS = 5;

function normalize(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Suggestions whose name contains what's been typed (ignoring case and extra spaces), names that
 * start with it first. Nothing until something is typed; nothing that's already on this wedding;
 * and nothing once the typed name exactly matches a suggestion (it's been picked or typed in full).
 */
export function matchVendorSuggestions(
  suggestions: VendorSuggestionDTO[],
  typed: string,
  namesOnThisWedding: string[]
): VendorSuggestionDTO[] {
  const q = normalize(typed);
  if (!q) return [];
  if (suggestions.some((s) => normalize(s.name) === q)) return [];
  const taken = new Set(namesOnThisWedding.map(normalize));
  return suggestions
    .filter((s) => !taken.has(normalize(s.name)) && normalize(s.name).includes(q))
    .sort((a, b) => {
      const aStarts = normalize(a.name).startsWith(q) ? 0 : 1;
      const bStarts = normalize(b.name).startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    })
    .slice(0, MAX_VENDOR_SUGGESTIONS);
}
