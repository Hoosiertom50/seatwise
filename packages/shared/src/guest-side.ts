// TS-177: a "Side" cell in a guest import, read the way the planner writes it. The Guests tab tells
// them to use their wedding's own side names (e.g. "Alex" / "Jordan"), but the import only took
// BRIDE / GROOM / BOTH, so following the on-screen example failed every row.
// TS-180: the order matters for a wedding whose sides are named "Groom" / "Bride" (first side
// "Groom"). After a cell that is exactly one of the wedding's names, come the stored values
// BRIDE / GROOM / BOTH in capitals (what older exports wrote), then the wedding's own names in any
// case (the export writes the names now), then "both" and
// plain bride / groom in any case. Before, the names came first in any case, so an older export's
// "GROOM" was read as the wedding's first side and every guest swapped sides on re-import.
export function parseGuestSide(
  raw: string,
  sideLabel1: string,
  sideLabel2: string
): { side: "BRIDE" | "GROOM" | "BOTH" } | { error: string } {
  const trimmed = raw.trim();
  // A cell that is exactly one of the wedding's names, capitals and all, is that side -- so a
  // wedding that names its sides "GROOM" / "BRIDE" still re-imports its own export.
  if (trimmed !== "" && trimmed === sideLabel1.trim()) return { side: "BRIDE" };
  if (trimmed !== "" && trimmed === sideLabel2.trim()) return { side: "GROOM" };
  if (trimmed === "BRIDE" || trimmed === "GROOM" || trimmed === "BOTH") return { side: trimmed };
  const value = trimmed.toLowerCase();
  const label1 = sideLabel1.trim().toLowerCase();
  const label2 = sideLabel2.trim().toLowerCase();
  if (value !== "" && value === label1) return { side: "BRIDE" };
  if (value !== "" && value === label2) return { side: "GROOM" };
  if (value === "both") return { side: "BOTH" };
  if (value === "bride") return { side: "BRIDE" };
  if (value === "groom") return { side: "GROOM" };
  return { error: `Side "${trimmed}" isn't one of ${sideLabel1}, ${sideLabel2} or Both.` };
}

/** TS-180: how the export writes a guest's side -- the wedding's own name for it, or "Both". */
export function guestSideLabel(side: string, sideLabel1: string, sideLabel2: string): string {
  if (side === "BRIDE") return sideLabel1;
  if (side === "GROOM") return sideLabel2;
  return "Both";
}

/**
 * TS-210: the export's "Side code" cell -- the stored side (BRIDE / GROOM / BOTH, any case), which
 * stays the same when the wedding's side names are renamed. A guest file only carried the names
 * before, so renaming "Bride"/"Groom" to "Groom"/"Partner" between the export and the re-import
 * quietly moved every guest to the other side.
 */
export function parseGuestSideCode(raw: string): { side: "BRIDE" | "GROOM" | "BOTH" } | { error: string } {
  const value = raw.trim().toUpperCase();
  if (value === "BRIDE" || value === "GROOM" || value === "BOTH") return { side: value };
  return { error: `Side code "${raw.trim()}" isn't one of BRIDE, GROOM or BOTH — leave the export's Side code column as it was.` };
}

/**
 * TS-210: a row whose Side name and Side code say different sides.
 * TS-222: a warning now, not an error -- the Side code wins (it doesn't change when the sides are
 * renamed). Re-importing an untouched export after renaming Bride/Groom to Groom/Partner used to
 * refuse every row on the renamed side, and the old advice (clear the Side code) moved those
 * guests to the other side. `sideName` is what the code's side is called now.
 */
export function sideMismatchMessage(sideCell: string, code: string, sideName: string): string {
  return `Side "${sideCell.trim()}" doesn't match Side code "${code}" — the side names may have been renamed since this file was exported, so the Side code is used (${sideName}). To put this guest on another side, change the Side code cell.`;
}
