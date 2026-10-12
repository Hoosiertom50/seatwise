// TS-256 item 2: unit tests for the import encoding gaps left after TS-254 -- a Windows "café »" file
// that happens to be valid UTF-8, the Mac's Turkish dotless ı (read as õ), Mac ö before t or p (read
// as š), and lone Windows "Hašler" and "Ka’iulani". Files are built from real windows-1252 and Mac
// Roman bytes. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";

const { decodeCsvFile, looksLikeMacRoman, MAC_ENCODING_MESSAGE, AMBIGUOUS_ENCODING_MESSAGE } = await import("../../../../packages/shared/src/text-decode");
const { parseCsv } = await import("../../../../packages/shared/src/csv");
const { parseGuestImportRow } = await import("../../../../packages/shared/src/guest-import-row");
const { prepareImportCsv } = await import("./guest-import-client");

const SIDES = { sideLabel1: "Bride", sideLabel2: "Groom" };
const NAMES = { firstName: "First name", lastName: "Last name" };

function encoder(label: string): (text: string) => Uint8Array {
  const decoder = new TextDecoder(label);
  const byChar = new Map<string, number>();
  for (let b = 0; b < 256; b++) byChar.set(decoder.decode(new Uint8Array([b])), b);
  return (text) =>
    new Uint8Array(
      [...text].map((ch) => {
        const b = byChar.get(ch);
        if (b === undefined) throw new Error(`not in ${label}: ${ch}`);
        return b;
      })
    );
}
const macRoman = encoder("macintosh");
const windows1252 = encoder("windows-1252");
const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

/** What importing a one-guest file would do: "refused", or the names that would be saved. */
function importOne(bytes: Uint8Array): "refused" | { firstName: string; lastName: string } {
  const { text, encoding } = decodeCsvFile(bytes);
  const prepared = prepareImportCsv(text, encoding, NAMES);
  if ("error" in prepared) {
    assert.ok(prepared.error.startsWith(MAC_ENCODING_MESSAGE), prepared.error);
    return "refused";
  }
  const { headers, rows } = parseCsv(prepared.csv);
  const row = parseGuestImportRow(rows[0], headers, NAMES, SIDES);
  assert.deepEqual(row.errors, []);
  return { firstName: row.data.firstName!, lastName: row.data.lastName! };
}

// --- a) a Windows file that happens to be valid UTF-8 ----------------------------------------------

test("TS-256: a file that could be Windows 'café »' or UTF-8 'Lee項' is refused with the CSV UTF-8 message, never guessed", () => {
  const refused = (bytes: Uint8Array) => assert.throws(() => decodeCsvFile(bytes), { message: AMBIGUOUS_ENCODING_MESSAGE });
  // Windows files whose only accents are "é »" -- valid UTF-8 by chance ("caf項" if read as UTF-8).
  // (\u00a0 is the no-break space French puts before » ¡ ¿.)
  for (const notes of ["café\u00a0»", "thé\u00a0¡ café\u00a0¿", "voilà\u00a0» oui", "café\u00a0… thé\u00a0»"]) {
    const bytes = windows1252(`First name,Last name,Notes\r\nAna,Lee,${notes}\r\n`);
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes), notes);
    refused(bytes);
  }
  // The same bytes from a real UTF-8 file: a CJK character glued to a Latin word. Reading it as
  // windows-1252 would save "Leeé …" without a word -- so it's refused too.
  refused(utf8("First name,Last name,Notes\r\nAna,Lee,Lee項\r\n"));
  refused(utf8("First name,Last name\r\nAna,Lee項\r\n"));
  // And at the start of a cell or after a digit: Windows "é »" would read as UTF-8 "頻", and a file
  // whose only CJK is one such character alone can't be told apart either.
  refused(windows1252("First name,Last name,Notes\r\nAna,Lee,é\u00a0»\r\n"));
  refused(windows1252("First name,Last name,Notes\r\nAna,Lee,2é\u00a0»\r\n"));
  refused(utf8("First name,Last name\r\nAna,項\r\n"));
  refused(utf8("First name,Last name\r\nAna,렀\r\n"));
  refused(utf8("First name,Last name\r\nAna 項,Lee\r\n"));
  // Saved again as "CSV UTF-8" (with the UTF-8 mark), both read exactly.
  const bom = (b: Uint8Array) => new Uint8Array([0xef, 0xbb, 0xbf, ...b]);
  assert.equal(decodeCsvFile(bom(utf8("Notes\r\ncafé\u00a0»\r\n"))).text, "Notes\r\ncafé\u00a0»\r\n");
  assert.equal(decodeCsvFile(bom(utf8("Notes\r\nLee項\r\n"))).text, "Notes\r\nLee項\r\n");
});

test("TS-256: real UTF-8 files with Chinese, Japanese and Korean names are still read as UTF-8", () => {
  for (const text of [
    "First name,Last name\r\n小明,王\r\n华,李\r\n",
    "First name,Last name\r\n花子,山田\r\n",
    "First name,Last name\r\n민준,김\r\n",
    // A CJK character in the same range as "é »" (項 is E9 A0 85) is fine next to other CJK.
    "First name,Last name\r\nAna,項\r\nBo,王\r\n",
    "First name,Last name\r\nAna,렀\r\nBo,김\r\n",
    // A Latin name and a CJK name in one cell, with a space between, next to other CJK.
    "First name,Last name\r\nAna 項,Lee\r\nBo,王\r\n",
    // "é »" bytes after a letter, but the file has other UTF-8 too.
    "First name,Last name\r\nJosé,Lee項\r\n",
    "First name,Last name\r\nAna,Lee項\r\nBo,王\r\n",
    // Plain UTF-8 accents.
    "First name,Last name\r\nJosé,Müller\r\n",
  ]) {
    const read = decodeCsvFile(utf8(text));
    assert.equal(read.encoding, "utf-8", text);
    assert.equal(read.text, text, text);
  }
});

// --- b) Mac dotless ı read as õ ---------------------------------------------------------------------

test("TS-256: Mac Roman Turkish names with ı (Yıldız, Aydın, Altın, Akın, Sarı, Kırmızı) are refused, not saved as Yõldõz", () => {
  assert.deepEqual([...macRoman("ı")], [0xf5]); // õ in windows-1252
  for (const name of ["Yıldız", "Aydın", "Altın", "Akın", "Sarı", "Kırmızı", "Tanrıverdi"]) {
    assert.equal(importOne(macRoman(`First name,Last name\r\nAna,${name}\r\n`)), "refused", name);
  }
});

test("TS-256: real windows-1252 õ names (Tõnis, Mõttus, Rõõmus, Kõiv, Simões, Camões, Magalhões) are still imported", () => {
  for (const name of ["Tõnis", "Mõttus", "Rõõmus", "Kõiv", "Põldma", "Lõhmus", "Simões", "Camões", "Magalhões", "Kalamõisa"]) {
    // A file with no other accented letter -- the strictest case.
    assert.deepEqual(importOne(windows1252(`First name,Last name\r\nAna,${name}\r\n`)), { firstName: "Ana", lastName: name }, name);
  }
  // An Estonian compound name with õ later in the word is refused only when nothing else shows it's a
  // Windows file; with any other Windows letter it's imported.
  assert.deepEqual(importOne(windows1252("First name,Last name\r\nMari,Rannapõld\r\nJüri,Tamm\r\n")), {
    firstName: "Mari",
    lastName: "Rannapõld",
  });
});

// --- c) Mac ö before t or p read as š ---------------------------------------------------------------

test("TS-256: Mac Roman ö before tt, tz, th, pf or pp (Göttsche, Töpfer, Götz, Köppen, Göthe) is refused", () => {
  for (const name of ["Göttsche", "Töpfer", "Götz", "Köppen", "Göthe", "Höpfner", "Röttgen"]) {
    assert.equal(importOne(macRoman(`First name,Last name\r\nAna,${name}\r\n`)), "refused", name);
  }
});

test("TS-256: Czech št and šp names (Krištof, Kašpar, Pešta, Vašta, Kašpárek, Špalek) are still imported", () => {
  for (const name of ["Krištof", "Kašpar", "Pešta", "Vašta", "Kašpárek", "Špalek", "Štefan", "Haštal"]) {
    assert.deepEqual(importOne(windows1252(`First name,Last name\r\nAna,${name}\r\n`)), { firstName: "Ana", lastName: name }, name);
  }
});

// --- d) lone Windows Hašler and Ka’iulani -----------------------------------------------------------

test("TS-256: a lone windows-1252 Hašler or Ka’iulani (or Hawai’i) is imported; Mac Möller, Mar’a and García are still refused", () => {
  assert.deepEqual(importOne(windows1252("First name,Last name\r\nKarel,Hašler\r\n")), { firstName: "Karel", lastName: "Hašler" });
  assert.deepEqual(importOne(windows1252("First name,Last name\r\nKa’iulani,Lee\r\n")), { firstName: "Ka'iulani", lastName: "Lee" });
  assert.deepEqual(importOne(windows1252("First name,Last name\r\nAna,Hawai’i\r\n")), { firstName: "Ana", lastName: "Hawai'i" });
  // Mac files are still refused: ö before l (Möller, Köhler) and í after a consonant (María, García,
  // Martínez, Rodríguez), and a Mac Ka’iulani (its ’ is Õ in windows-1252).
  for (const [first, last] of [
    ["Ana", "Möller"],
    ["Ana", "Söll"],
    ["María", "Lee"],
    ["Ana", "García"],
    ["Ana", "Martínez"],
    ["Ana", "Rodríguez"],
    ["Ka’iulani", "Lee"],
  ]) {
    assert.equal(importOne(macRoman(`First name,Last name\r\n${first},${last}\r\n`)), "refused", `${first} ${last}`);
  }
  assert.equal(looksLikeMacRoman("Mar’a", true), true);
  assert.equal(looksLikeMacRoman("Ka’iulani", true), false);
  assert.equal(looksLikeMacRoman("Hašler", true), false);
  assert.equal(looksLikeMacRoman("Mšller", true), true);
});
