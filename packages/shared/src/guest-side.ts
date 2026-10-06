// TS-177: a "Side" cell in a guest import, read the way the planner writes it. The Guests tab tells
// them to use their wedding's own side names (e.g. "Alex" / "Jordan"), but the import only took
// BRIDE / GROOM / BOTH, so following the on-screen example failed every row. The wedding's names
// come first (so a wedding that calls its first side "Groom" gets what it means), then "Both",
// then the stored values BRIDE / GROOM themselves. Case and surrounding spaces don't matter.
export function parseGuestSide(
  raw: string,
  sideLabel1: string,
  sideLabel2: string
): { side: "BRIDE" | "GROOM" | "BOTH" } | { error: string } {
  const value = raw.trim().toLowerCase();
  const label1 = sideLabel1.trim().toLowerCase();
  const label2 = sideLabel2.trim().toLowerCase();
  if (value !== "" && value === label1) return { side: "BRIDE" };
  if (value !== "" && value === label2) return { side: "GROOM" };
  if (value === "both") return { side: "BOTH" };
  if (value === "bride") return { side: "BRIDE" };
  if (value === "groom") return { side: "GROOM" };
  return { error: `Side "${raw.trim()}" isn't one of ${sideLabel1}, ${sideLabel2} or Both.` };
}
