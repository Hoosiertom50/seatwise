// TS-199: floor plans draw each table at its saved spot, but Tab (and a screen reader) follow the
// order the tables are listed in -- which was the order they were made, so Tab jumped around the
// room. Listed in reading order instead: rows top to bottom, each row left to right. Tables whose
// tops are within the same band (40px by default) count as one row, so a table a few pixels lower
// than its neighbour isn't read after the whole rest of the row.

export const READING_ORDER_ROW_BAND = 40;

export function inReadingOrder<T>(
  items: readonly T[],
  position: (item: T) => { x: number; y: number },
  rowBand: number = READING_ORDER_ROW_BAND,
): T[] {
  return items
    .map((item, index) => ({ item, index, pos: position(item) }))
    .sort(
      (a, b) =>
        Math.round(a.pos.y / rowBand) - Math.round(b.pos.y / rowBand) ||
        a.pos.x - b.pos.x ||
        // Same spot: keep the order they came in.
        a.index - b.index,
    )
    .map((entry) => entry.item);
}
