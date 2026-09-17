// Table labels are free text ("Table 1", "Head Table", "VIP 3", ...), but the common case is a
// numbered sequence, and a plain string sort puts "Table 10" and "Table 11" before "Table 2"
// because it compares character-by-character rather than by numeric value. `Intl.Collator` with
// `numeric: true` compares embedded digit runs as numbers instead, so "Table 2" sorts before
// "Table 10" while still falling back to ordinary alphabetical comparison for labels that aren't
// numbered at all (e.g. "Head Table" vs "VIP Table").
//
// Constructing an Intl.Collator has real overhead, so this is built once and reused everywhere a
// list of tables needs to be shown in a sensible order -- the tables tab, the seating-plan
// assignment dropdowns, and anywhere else a table list is rendered.
const tableLabelCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareTableLabels(a: string, b: string): number {
  return tableLabelCollator.compare(a, b);
}
