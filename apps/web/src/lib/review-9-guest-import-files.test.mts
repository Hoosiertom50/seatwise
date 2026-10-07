// TS-233: unit tests for review 9's guest import fixes -- ordinary Windows files no longer refused
// (a curly apostrophe in Household or Plus-ones, ‹ › † in notes, French quotes), the header looked
// up once and capped at 200 columns, files refused after being read still counted against the
// hourly limit, and a too-big file's own message. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";

const { decodeCsvFile, CsvEncodingError, MIXED_ENCODING_MESSAGE, looksLikeMacRoman, findMacRomanCell, MAC_ENCODING_MESSAGE } =
  await import("../../../../packages/shared/src/text-decode");
const { parseCsv, toCsv, headerIndexMap, MAX_IMPORT_COLUMNS, tooManyColumnsMessage } = await import("../../../../packages/shared/src/csv");
const { parseGuestImportRow } = await import("../../../../packages/shared/src/guest-import-row");
const { prepareImportCsv } = await import("./guest-import-client");
const { pool, classifyGuestImport, GuestImportError } = await import("@seatwise/db");
const { limitedWeddingWork, refusedButCounted } = await import("./rate-limit");
const { ApiError, apiErrorMessage } = await import("./api-client");

const SIDES = { sideLabel1: "Bride", sideLabel2: "Groom" };

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

// --- Item 1: ordinary Windows files ------------------------------------------------------------

test("TS-233: a Windows file with a curly apostrophe in Household and Plus-ones is imported, not refused as the Mac format", () => {
  const text =
    "First name,Last name,Household,Plus-ones\r\nAna,Lee,Bride’s college friends,Sarah’s husband Tom\r\n";
  const bytes = windows1252(text);
  assert.equal(bytes[bytes.indexOf(0x92)], 0x92); // a real windows-1252 ’ byte
  const { text: read, encoding } = decodeCsvFile(bytes);
  assert.equal(encoding, "windows-1252");
  assert.equal(read, text);
  const prepared = prepareImportCsv(read, encoding, {
    firstName: "First name",
    lastName: "Last name",
    partyName: "Household",
    plusOneNames: "Plus-ones",
  });
  assert.ok("csv" in prepared, JSON.stringify(prepared));
  const { headers, rows } = parseCsv(prepared.csv);
  const row = parseGuestImportRow(rows[0], headers, { firstName: "First name", lastName: "Last name", partyName: "Household", plusOneNames: "Plus-ones" }, SIDES);
  assert.equal(row.data.partyName, "Bride’s college friends");
});

test("TS-233: ‹VIP› and †Opa in a Windows notes cell are imported (the start-of-word rule is for names only)", () => {
  const text = "First name,Last name,Notes\r\nAna,Lee,‹VIP›\r\nBo,Ray,In memory of †Opa\r\nCy,Fox,ƒ-stop fan\r\n";
  const { text: read, encoding } = decodeCsvFile(windows1252(text));
  assert.equal(encoding, "windows-1252");
  assert.equal(read, text);
  assert.ok("csv" in prepareImportCsv(read, encoding, { firstName: "First name", lastName: "Last name", notes: "Notes" }));
  for (const note of ["‹VIP›", "In memory of †Opa", "Bride’s friends"]) assert.equal(looksLikeMacRoman(note, false), false, note);
});

test("TS-233: French quotes with no-break spaces (« Pas de café », bytes E9 A0 BB) in a Windows file are read, not refused as mixed", () => {
  const text = "First name,Last name,Notes\r\nAna,Lee,« Pas de café »\r\n";
  const bytes = windows1252(text);
  const at = bytes.indexOf(0xe9);
  assert.deepEqual([...bytes.subarray(at, at + 3)], [0xe9, 0xa0, 0xbb]);
  const { text: read, encoding } = decodeCsvFile(bytes);
  assert.equal(encoding, "windows-1252");
  assert.equal(read, text);
  assert.ok("csv" in prepareImportCsv(read, encoding, { firstName: "First name", lastName: "Last name", notes: "Notes" }));
  // Twice in one file.
  assert.equal(decodeCsvFile(windows1252("Notes\r\n« café »\r\n« thé »\r\n")).encoding, "windows-1252");
});

test("TS-233: real mixed-format files are still refused", () => {
  const refused = (bytes: Uint8Array) =>
    assert.throws(() => decodeCsvFile(bytes), (err: unknown) => err instanceof CsvEncodingError && (err as Error).message === MIXED_ENCODING_MESSAGE);
  // UTF-8 é and a stray byte.
  refused(new Uint8Array([...Buffer.from("First name,Last name\r\nJosé,Lee\r\n", "utf8"), 0xe9]));
  // Only a UTF-8 curly apostrophe (E2 80 99, "â€™" in windows-1252) and a stray byte.
  refused(new Uint8Array([...Buffer.from("Notes\r\nit’s here\r\n", "utf8"), 0xe9]));
  // UTF-8 Chinese names and a stray byte.
  refused(new Uint8Array([...Buffer.from("Last name\r\n王小明\r\n李华\r\n", "utf8"), 0xe9]));
});

test("TS-233: Mac-format names are still caught, in first and last name", () => {
  for (const name of ["MŸller", "ƒloise", "‡ngel", "RenŽe", "Mar’a"]) assert.equal(looksLikeMacRoman(name, true), true, name);
  const text = "First name,Last name,Household\r\nƒloise,Lee,Mar’a’s family\r\n";
  const { text: read, encoding } = decodeCsvFile(windows1252(text));
  const prepared = prepareImportCsv(read, encoding, { firstName: "First name", lastName: "Last name", partyName: "Household" });
  assert.deepEqual(prepared, { error: `${MAC_ENCODING_MESSAGE} (First seen in row 2, column "First name".)` });
  // "MŸller" (capital, Ÿ, small letter) is caught in any column.
  assert.deepEqual(findMacRomanCell([["Ana", "x", "MŸller family"]], [0, 1, 2], [0, 1]), { rowNumber: 1, column: 2 });
});

// --- Item 2: the header map, and the column cap ---------------------------------------------------

test("TS-233: headerIndexMap finds each header's first column, and parseGuestImportRow reads the same with it", () => {
  const headers = ["First name", "Last name", "Notes", "Notes2"];
  const map = headerIndexMap(headers);
  assert.equal(map.get("Notes"), 2);
  assert.equal(map.get("Missing"), undefined);
  assert.equal(headerIndexMap(["a", "b", "a"]).get("a"), 0);
  const mapping = { firstName: "First name", lastName: "Last name", notes: "Notes" };
  const cells = ["Ana", "Lee", "Vegan", "x"];
  assert.deepEqual(parseGuestImportRow(cells, map, mapping, SIDES), parseGuestImportRow(cells, headers, mapping, SIDES));
});

test("TS-233: a wide header row is read quickly with the map (one lookup per field, not a search per cell)", () => {
  const headers = [...Array.from({ length: 50_000 }, (_, i) => `c${i}`), "First name", "Last name"];
  const map = headerIndexMap(headers);
  const cells = [...Array.from({ length: 50_000 }, () => ""), "Ana", "Lee"];
  const mapping = { firstName: "First name", lastName: "Last name" };
  const started = performance.now();
  for (let i = 0; i < 2000; i++) parseGuestImportRow(cells, map, mapping, SIDES);
  assert.ok(performance.now() - started < 2000, "2,000 rows took too long");
});

test("TS-233: a file with more than 200 columns is refused with a plain message, on the screen and by the server", async () => {
  assert.equal(MAX_IMPORT_COLUMNS, 200);
  const headers = ["First name", "Last name", ...Array.from({ length: 199 }, (_, i) => `Extra ${i}`)];
  const csv = toCsv(headers, [headers.map(() => "x")]);
  const message = tooManyColumnsMessage(201);
  assert.equal(message, "That file has 201 columns — keep it to at most 200 (delete the columns you don't need), then choose it again.");
  assert.deepEqual(prepareImportCsv(csv, "utf-8", { firstName: "First name", lastName: "Last name" }), { error: message });
  // Exactly 200 is fine.
  assert.ok("csv" in prepareImportCsv(toCsv(headers.slice(0, 200), [headers.slice(0, 200)]), "utf-8", { firstName: "First name", lastName: "Last name" }));
  // The server refuses before reading any guests (no database needed).
  await assert.rejects(
    classifyGuestImport("w1", csv, { firstName: "First name", lastName: "Last name" }),
    (err: unknown) => err instanceof GuestImportError && (err as Error).message === message
  );
});

// --- Item 3: refused files still count against the hourly limit -----------------------------------

const counts = new Map<string, number>();
const realQuery = pool.query.bind(pool);
function fakeCounters() {
  counts.clear();
  (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
    const key = `${params[0]}@${params[1]}`;
    if (/^INSERT INTO "rate_limit_counters"/.test(sql.trim())) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { rows: [{ count: counts.get(key) }] };
    }
    if (/^UPDATE "rate_limit_counters" SET count = GREATEST/.test(sql.trim())) {
      counts.set(key, Math.max((counts.get(key) ?? 0) - 1, 0));
      return { rows: [] };
    }
    if (/^SELECT count FROM "rate_limit_counters"/.test(sql.trim())) return { rows: [] };
    if (/^DELETE FROM "rate_limit_counters"/.test(sql.trim())) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  };
}
afterEach(() => {
  (pool as unknown as { query: unknown }).query = realQuery;
});
const total = () => [...counts.values()].reduce((a, b) => a + b, 0);

test("TS-233: an import file refused after being read keeps its count; bad requests, conflicts, busy and errors are given back", async () => {
  for (const kind of ["importPreview", "importCommit"] as const) {
    fakeCounters();
    const refused = await limitedWeddingWork(kind, "u1", async () =>
      refusedButCounted(NextResponse.json({ error: "row(s) still have errors" }, { status: 422 }))
    );
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).error, "row(s) still have errors");
    assert.equal(total(), 1, kind);
    await limitedWeddingWork(kind, "u1", async () => NextResponse.json({ error: "Validation failed" }, { status: 422 }));
    await limitedWeddingWork(kind, "u1", async () => NextResponse.json({ error: "changed" }, { status: 409 }));
    await limitedWeddingWork(kind, "u1", async () => NextResponse.json({ error: "busy" }, { status: 503 }));
    await assert.rejects(limitedWeddingWork(kind, "u1", async () => Promise.reject(new Error("boom"))));
    assert.equal(total(), 1, kind);
  }
});

test("TS-233: a file refused this way still runs into the limit when sent in a loop", async () => {
  fakeCounters();
  for (let i = 0; i < 60; i++) {
    const r = await limitedWeddingWork("importPreview", "u1", async () =>
      refusedButCounted(NextResponse.json({ error: "unclosed quote" }, { status: 422 }))
    );
    assert.equal(r.status, 422);
  }
  let ran = false;
  const limited = await limitedWeddingWork("importPreview", "u1", async () => {
    ran = true;
    return NextResponse.json({});
  });
  assert.equal(limited.status, 429);
  assert.equal(ran, false);
});

// --- Item 4: the too-big file's own message --------------------------------------------------------

test("TS-233: the import shows the csv field's reason (too big), not 'Validation failed'", () => {
  const err = new ApiError("Validation failed", 422, { csv: ["That file is too big — keep it under 2 MB."] });
  assert.equal(apiErrorMessage(err, ["csv"], "Couldn't preview that file."), "That file is too big — keep it under 2 MB.");
  assert.equal(apiErrorMessage(new ApiError("Nothing was imported", 422), ["csv"], "x"), "Nothing was imported");
  assert.equal(apiErrorMessage(new Error("x"), ["csv"], "Couldn't complete that import."), "Couldn't complete that import.");
});
