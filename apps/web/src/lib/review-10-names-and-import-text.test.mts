// TS-243 / TS-241 / TS-237: unit tests for review 10's name and import-text fixes -- names from an
// older Mac file caught (built from real Mac Roman bytes), curly apostrophes and no-break spaces in
// names made plain, a tab in a header quoted, UTF-16 without a byte-order mark recognised with an
// early 一 or Ā, import conflicts counted against the hourly limit, and repeated French quotes in a
// Windows file not read as UTF-8. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
process.env.JWT_SECRET = randomBytes(32).toString("hex");

const { decodeCsvFile, CsvEncodingError, MIXED_ENCODING_MESSAGE, looksLikeMacRoman, findMacRomanCell, MAC_ENCODING_MESSAGE } =
  await import("../../../../packages/shared/src/text-decode");
const { parseCsv, toCsv, detectCsvDelimiter } = await import("../../../../packages/shared/src/csv");
const { parseGuestImportRow } = await import("../../../../packages/shared/src/guest-import-row");
const { createGuestSchema, updateGuestSchema } = await import("../../../../packages/shared/src/schemas/guest");
const { normalizePersonName } = await import("../../../../packages/shared/src/validation");
const { prepareImportCsv } = await import("./guest-import-client");
const { signToken } = await import("./auth");
const { pool } = await import("@seatwise/db");
const { NextRequest } = await import("next/server");

const SIDES = { sideLabel1: "Bride", sideLabel2: "Groom" };
const NAMES = { firstName: "First name", lastName: "Last name" };

// Real Mac Roman bytes: the reverse of the platform's own Mac Roman decoder.
const MAC_DECODER = new TextDecoder("macintosh");
const MAC_BYTE = new Map<string, number>();
for (let b = 0; b < 256; b++) MAC_BYTE.set(MAC_DECODER.decode(new Uint8Array([b])), b);
function macRoman(text: string): Uint8Array {
  return new Uint8Array(
    [...text].map((ch) => {
      const b = MAC_BYTE.get(ch);
      if (b === undefined) throw new Error(`not in Mac Roman: ${ch}`);
      return b;
    })
  );
}

// The real windows-1252 table for 0x80-0x9F (0xA0-0xFF are the same as Latin-1).
const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
function windows1252(text: string): Uint8Array {
  return new Uint8Array(
    [...text].map((ch) => {
      const at = CP1252_HIGH.indexOf(ch);
      if (at !== -1) return 0x80 + at;
      const code = ch.charCodeAt(0);
      if (code > 0xff) throw new Error(`not in windows-1252: ${ch}`);
      return code;
    })
  );
}

// --- TS-243 item 1: Mac Roman names -----------------------------------------------------------------

const MAC_NAMES: [string, string][] = [
  ["Ángel", "Ruiz"],
  ["Óscar", "Diaz"],
  ["Úrsula", "Vega"],
  ["Jesús", "Lopez"],
  ["Raúl", "Ortiz"],
  ["Èric", "Martin"],
];

test("TS-243: names from a real Mac Roman file (Ángel, Óscar, Úrsula, Jesús, Raúl, Èric) are refused, not saved with the wrong letters", () => {
  // The bytes really are Mac Roman: Á is E7, ú is 9C -- read as windows-1252 they are ç and œ.
  assert.deepEqual([...macRoman("Áú")], [0xe7, 0x9c]);
  for (const [first, last] of MAC_NAMES) {
    const text = `First name,Last name\r\nAna,Lee\r\n${first},${last}\r\n`;
    const { text: read, encoding } = decodeCsvFile(macRoman(text));
    assert.equal(encoding, "windows-1252", first);
    assert.notEqual(read, text, first); // read with the wrong letters ("çngel", "Jesœs")
    assert.deepEqual(
      prepareImportCsv(read, encoding, NAMES),
      { error: `${MAC_ENCODING_MESSAGE} (First seen in row 3, column "First name".)` },
      first
    );
  }
  // As a last name too.
  const { text: read, encoding } = decodeCsvFile(macRoman("First name,Last name\r\nAna,Núñez\r\nBo,Ávila\r\n"));
  assert.deepEqual(findMacRomanCell(parseCsv(read).rows, [0, 1], [0, 1]), { rowNumber: 2, column: 1 });
  assert.ok("error" in prepareImportCsv(read, encoding, NAMES));
});

test("TS-243: real windows-1252 names (François, José, Zoë, Ægir, Øyvind, Ñuñez, Ángel, Éloise, Lacœur…) are still imported", () => {
  const names = [
    ["François", "Dupont"],
    ["José", "García Márquez"],
    ["Zoë", "Brontë"],
    ["Ægir", "Ødegård"],
    ["Øyvind", "Søreide"],
    ["Ana", "Ñuñez"],
    ["Ángel", "Ruiz"],
    ["Éloise", "d'Évreux"],
    ["Óscar", "Ó Briain"],
    ["Hélène", "Lacœur"],
    ["Chloë", "Lœillet"],
    ["Björk", "Žižek"],
    ["Þór", "Ólafsson"],
    ["Ömer", "Çelik"],
  ];
  const text = `First name,Last name\r\n${names.map((n) => n.join(",")).join("\r\n")}\r\n`;
  const { text: read, encoding } = decodeCsvFile(windows1252(text));
  assert.equal(encoding, "windows-1252");
  assert.equal(read, text);
  const prepared = prepareImportCsv(read, encoding, NAMES);
  assert.ok("csv" in prepared, JSON.stringify(prepared));
  for (const [first, last] of names) {
    assert.equal(looksLikeMacRoman(first, true), false, first);
    assert.equal(looksLikeMacRoman(last, true), false, last);
  }
});

test("TS-243: a file typed all in small letters can hold a real 'élodie' (the small-letter start rule needs capitalised names)", () => {
  const text = "First name,Last name\r\nélodie,martin\r\nana,lee\r\n";
  const { text: read, encoding } = decodeCsvFile(windows1252(text));
  assert.equal(encoding, "windows-1252");
  assert.ok("csv" in prepareImportCsv(read, encoding, NAMES));
  // The same name in a file whose names start with capitals is the Mac È.
  assert.ok("error" in prepareImportCsv("First name,Last name\r\néric,Martin\r\nAna,Lee\r\n", "windows-1252", NAMES));
  // Only for names: a notes cell may start with a small accented letter.
  assert.equal(looksLikeMacRoman("à la carte", false), false);
  assert.equal(looksLikeMacRoman("çngel", true), true);
  assert.equal(looksLikeMacRoman("Jesœs", true), true);
});

// --- TS-243 item 2: curly apostrophes and no-break spaces -------------------------------------------

test("TS-243: a curly apostrophe or no-break space in a name is accepted by the add and edit forms, and saved plain", () => {
  assert.equal(normalizePersonName("O’Brien"), "O'Brien");
  assert.equal(normalizePersonName("D‘Arcy"), "D'Arcy");
  assert.equal(normalizePersonName("Kaʼiulani"), "Ka'iulani");
  assert.equal(normalizePersonName("Mary Ann"), "Mary Ann");
  const created = createGuestSchema.safeParse({ firstName: "Mary Ann", lastName: "O’Brien" });
  assert.ok(created.success, JSON.stringify(created.error?.issues));
  assert.equal(created.data.firstName, "Mary Ann");
  assert.equal(created.data.lastName, "O'Brien");
  const updated = updateGuestSchema.safeParse({ lastName: "Kaʼiulani " });
  assert.ok(updated.success);
  assert.equal(updated.data.lastName, "Ka'iulani");
  // Still refused: other symbols, and a name that's only an apostrophe.
  assert.equal(createGuestSchema.safeParse({ firstName: "Ana", lastName: "O”Brien" }).success, false);
  assert.equal(createGuestSchema.safeParse({ firstName: "’", lastName: "Lee" }).success, false);
  // A name too long is still refused by length first.
  assert.equal(createGuestSchema.safeParse({ firstName: "a".repeat(101), lastName: "Lee" }).success, false);
});

test("TS-243: an import row with O’Brien or a no-break space is imported, with the plain form saved", () => {
  const csv = "First name,Last name\r\nMary Ann,O’Brien\r\n";
  const { headers, rows } = parseCsv(csv);
  const row = parseGuestImportRow(rows[0], headers, NAMES, SIDES);
  assert.deepEqual(row.errors, []);
  assert.equal(row.data.firstName, "Mary Ann");
  assert.equal(row.data.lastName, "O'Brien");
});

// --- TS-243 item 3: a tab in a header ----------------------------------------------------------------

test("TS-243: a header with tabs is quoted when the import re-sends the file, so it is still read as comma-separated", () => {
  assert.equal(toCsv(["a\tb"], []), "﻿\"a\tb\"\r\n");
  const file = '"First\tname","Last\tname","Notes\there"\r\nAna,Lee,x\r\n';
  const mapping = { firstName: "First\tname", lastName: "Last\tname", notes: "Notes\there" };
  const prepared = prepareImportCsv(file, "utf-8", mapping);
  assert.ok("csv" in prepared, JSON.stringify(prepared));
  assert.equal(detectCsvDelimiter(prepared.csv.replace(/^﻿/, "")), ",");
  const { headers, rows } = parseCsv(prepared.csv);
  assert.deepEqual(headers, ["First\tname", "Last\tname", "Notes\there"]);
  const row = parseGuestImportRow(rows[0], headers, mapping, SIDES);
  assert.deepEqual(row.errors, []);
  assert.equal(row.data.firstName, "Ana");
});

// --- TS-243 item 4: UTF-16 without a byte-order mark -------------------------------------------------

function utf16(text: string, order: "le" | "be"): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2 + (order === "le" ? 0 : 1)] = code & 0xff;
    out[i * 2 + (order === "le" ? 1 : 0)] = code >> 8;
  }
  return out;
}

test("TS-243: UTF-16 without a byte-order mark is read even when an early character's code ends in 00 (一, Ā, Ō, Ѐ)", () => {
  for (const text of [
    "First name,Last name\r\n一,Lee\r\n",
    "First name,Last name\r\nĀ,Ō\r\nЀ,Lee\r\n",
    "First name,Last name\r\nAna,Lee\r\n",
  ]) {
    for (const order of ["le", "be"] as const) {
      const { text: read, encoding } = decodeCsvFile(utf16(text, order));
      assert.equal(encoding, "utf-16", `${order} ${text}`);
      assert.equal(read, text, order);
      assert.deepEqual(parseCsv(read).headers, ["First name", "Last name"]);
    }
  }
  // Plain ASCII and UTF-8 files are not mistaken for UTF-16.
  assert.equal(decodeCsvFile(Buffer.from("First name,Last name\r\nAna,Lee\r\n", "utf8")).encoding, "utf-8");
  assert.equal(decodeCsvFile(Buffer.from("First name,Last name\r\n一,Ā\r\n", "utf8")).encoding, "utf-8");
});

// --- TS-237 item 7: repeated French quotes in a Windows file -----------------------------------------

test("TS-237: José with 'café » café »' in a windows-1252 file is imported, not refused as mixed", () => {
  const text = "First name,Last name,Notes\r\nJosé,Lee,café\u00a0» café\u00a0»\r\n";
  const bytes = windows1252(text);
  assert.equal(bytes.filter((b) => b === 0xa0).length, 2);
  const { text: read, encoding } = decodeCsvFile(bytes);
  assert.equal(encoding, "windows-1252");
  assert.equal(read, text);
  assert.ok("csv" in prepareImportCsv(read, encoding, { ...NAMES, notes: "Notes" }));
  // Other French marks after a no-break space too (« ¿ ¡ :).
  assert.equal(decodeCsvFile(windows1252("Notes\r\nJosé\r\nthé\u00a0« oui\u00a0» thé\u00a0¿ non\u00a0¡\r\n")).encoding, "windows-1252");
});

test("TS-237: real mixed-encoding files are still refused", () => {
  const refused = (bytes: Uint8Array) =>
    assert.throws(() => decodeCsvFile(bytes), (err: unknown) => err instanceof CsvEncodingError && (err as Error).message === MIXED_ENCODING_MESSAGE);
  refused(new Uint8Array([...Buffer.from("First name,Last name\r\nJosé,Lee\r\n", "utf8"), 0xe9]));
  refused(new Uint8Array([...Buffer.from("Last name\r\n王小明\r\n李华\r\n", "utf8"), 0xe9]));
  refused(new Uint8Array([...Buffer.from("Notes\r\nit’s here\r\n", "utf8"), 0xe9]));
});

// --- TS-241 item 3: import conflicts keep their hourly count ----------------------------------------

const counts = new Map<string, number>();
const realQuery = pool.query.bind(pool);
/** The database as a stand-in: one signed-in owner of wedding "w", with no guests, and real hourly counts. */
function weddingWithNoGuests() {
  counts.clear();
  (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
    const s = sql.trim();
    const key = `${params[0]}@${params[1]}`;
    if (/FROM "users"/.test(s)) {
      return { rows: [{ id: "u1", email: "u1@example.invalid", name: "u1", passwordHash: "x", sessionVersion: 0, emailVerifiedAt: new Date() }] };
    }
    if (/revoked_sessions/.test(s)) return { rows: [] };
    if (/^INSERT INTO "rate_limit_counters"/.test(s)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { rows: [{ count: counts.get(key) }] };
    }
    if (/^UPDATE "rate_limit_counters" SET count = GREATEST/.test(s)) {
      counts.set(key, Math.max((counts.get(key) ?? 0) - 1, 0));
      return { rows: [] };
    }
    if (/^SELECT count FROM "rate_limit_counters"/.test(s) || /^DELETE FROM "rate_limit_counters"/.test(s)) return { rows: [] };
    if (/SELECT "ownerId" FROM "weddings"/.test(s)) return { rows: [{ ownerId: "u1" }] };
    if (/FROM "weddings"/.test(s)) return { rows: [{ id: "w", ownerId: "u1", name: "W", sideLabel1: "Bride", sideLabel2: "Groom" }] };
    if (/FROM "wedding_collaborators"/.test(s)) return { rows: [] };
    if (/FROM "guests"/.test(s)) return { rows: [] };
    throw new Error(`unexpected query: ${s}`);
  };
}
afterEach(() => {
  (pool as unknown as { query: unknown }).query = realQuery;
});

test("TS-241: an import refused because a guest in it was deleted (a conflict) still counts against the hourly limit", async () => {
  weddingWithNoGuests();
  const token = await signToken({ sub: "u1", email: "u1@example.invalid", authTime: Math.floor(Date.now() / 1000), sessionVersion: 0 });
  const { POST: commit } = await import("../app/api/v1/weddings/[weddingId]/guests/import/commit/route");
  const res: Response = await commit(
    new NextRequest("http://localhost/api/v1/weddings/w/guests/import/commit", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        csv: "Guest ID,First name,Last name\r\ngone,Ana,Lee\r\n",
        mapping: { guestId: "Guest ID", ...NAMES },
        expectedRevisions: { gone: 1 },
      }),
    }),
    { params: Promise.resolve({ weddingId: "w" }) }
  );
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /deleted since you previewed it/);
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 1);
});
