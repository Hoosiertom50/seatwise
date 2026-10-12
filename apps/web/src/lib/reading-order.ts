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
  // TS-212: rows are grouped from the top down -- a row starts at its highest table and takes every
  // table no more than `rowBand` below that one. It used to round each top onto a fixed 40px grid,
  // so two tables at 59 and 61 fell into different rows (and a 10px wobble split a row about a
  // quarter of the time).
  const byTop = items
    .map((item, index) => ({ item, index, pos: position(item) }))
    .sort((a, b) => a.pos.y - b.pos.y || a.index - b.index);
  const rows: (typeof byTop)[] = [];
  for (const entry of byTop) {
    const row = rows[rows.length - 1];
    if (row && entry.pos.y - row[0].pos.y <= rowBand) row.push(entry);
    else rows.push([entry]);
  }
  return rows.flatMap((row) =>
    row
      // Same spot: keep the order they came in.
      .sort((a, b) => a.pos.x - b.pos.x || a.index - b.index)
      .map((entry) => entry.item),
  );
}
