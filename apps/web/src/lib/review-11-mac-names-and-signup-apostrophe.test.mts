// TS-254 / TS-248: unit tests for review 11's import-name and sign-up-name fixes -- Mac Roman ë, í, ö
// and curly apostrophes caught (built from real Mac Roman bytes), windows-1252 "Ka’iulani" and
// "Ja’nae" imported when the file is clearly a Windows file, Windows punctuation in 80-9F not read
// as UTF-8, and a curly apostrophe accepted in a sign-up name. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";

const { decodeCsvFile, looksLikeMacRoman, findMacRomanCell, hasWindowsLetters, MAC_ENCODING_MESSAGE } =
  await import("../../../../packages/shared/src/text-decode");
const { parseCsv } = await import("../../../../packages/shared/src/csv");
const { parseGuestImportRow } = await import("../../../../packages/shared/src/guest-import-row");
const { signupSchema } = await import("../../../../packages/shared/src/schemas/auth");
const { prepareImportCsv } = await import("./guest-import-client");

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

// Real windows-1252 bytes, the same way.
const WIN_DECODER = new TextDecoder("windows-1252");
const WIN_BYTE = new Map<string, number>();
for (let b = 0; b < 256; b++) WIN_BYTE.set(WIN_DECODER.decode(new Uint8Array([b])), b);
function windows1252(text: string): Uint8Array {
  return new Uint8Array(
    [...text].map((ch) => {
      const b = WIN_BYTE.get(ch);
      if (b === undefined) throw new Error(`not in windows-1252: ${ch}`);
      return b;
    })
  );
}

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

// --- TS-254 item 1: Mac ë and í at the end of a word ------------------------------------------------

test("TS-254: Mac Roman names ending in ë or í (Zoë, Chloë, Brontë, Martí, Leví, Ana-Martí, Zoë Ann) are refused, not saved as Zo'", () => {
  // The bytes really are Mac Roman: ë is 91 and í is 92 -- read as windows-1252 they are ‘ and ’.
  assert.deepEqual([...macRoman("ëí")], [0x91, 0x92]);
  for (const [first, last] of [
    ["Zoë", "Smith"],
    ["Chloë", "Smith"],
    ["Ana", "Brontë"],
    ["Martí", "Smith"],
    ["Leví", "Smith"],
    ["Ana-Martí", "Smith"],
    ["Zoë Ann", "Smith"],
    ["Ana", "Martí"],
  ]) {
    assert.equal(importOne(macRoman(`First name,Last name\r\n${first},${last}\r\n`)), "refused", `${first} ${last}`);
  }
  assert.equal(looksLikeMacRoman("Zo‘", true), true);
  assert.equal(looksLikeMacRoman("Mart’", true), true);
  assert.equal(looksLikeMacRoman("Zo‘-Ann", true), true);
});

test("TS-254: a Mac file with Mac curly apostrophes (O’Brien, D‘Arcy, Ka’iulani) is refused, not saved as OÕBrien", () => {
  for (const first of ["O’Brien", "D‘Arcy", "Ka’iulani"]) {
    assert.equal(importOne(macRoman(`First name,Last name\r\n${first},Smith\r\n`)), "refused", first);
  }
});

test("TS-254: a Mac ú after a capital (Núria read as Nœria) is refused; French Cœur and Bœuf are not", () => {
  assert.equal(importOne(macRoman("First name,Last name\r\nNúria,Smith\r\n")), "refused");
  assert.equal(looksLikeMacRoman("Cœur", true), false);
  assert.equal(looksLikeMacRoman("Bœuf", true), false);
});

test("TS-254: a quoted nickname in a Windows name (Robert ‘Bob’) is not the Mac sign", () => {
  assert.equal(looksLikeMacRoman("Robert ‘Bob’", true), false);
  assert.equal(looksLikeMacRoman("‘Bob’", true), false);
  // Only in name columns: in a notes cell "the Smiths’" is ordinary text.
  assert.equal(looksLikeMacRoman("from the Smiths’", false), false);
});

// --- TS-254 item 2: Mac ö read as š -----------------------------------------------------------------

test("TS-254: Mac Roman ö names (Björn, Göran, Möller, Jönsson, Schröder, Köhler, Söderberg, Rössler, Römer) are refused", () => {
  assert.deepEqual([...macRoman("ö")], [0x9a]); // š in windows-1252
  for (const first of ["Björn", "Göran", "Möller", "Jönsson", "Schröder", "Köhler", "Söderberg", "Rössler", "Römer"]) {
    assert.equal(importOne(macRoman(`First name,Last name\r\n${first},Smith\r\nAna,Lee\r\n`)), "refused", first);
  }
});

test("TS-254: real windows-1252 š names (Kašpar, Hašek, Dušan, Miloš, Krištof, Šimon, Pešek, Muška) are still imported", () => {
  for (const first of ["Kašpar", "Hašek", "Dušan", "Miloš", "Krištof", "Šimon", "Pešek", "Muška", "Blaško", "Kašpárek"]) {
    // A file with no other accented letter at all -- the strictest case.
    assert.deepEqual(importOne(windows1252(`First name,Last name\r\n${first},Smith\r\n`)), { firstName: first, lastName: "Smith" }, first);
  }
  // "Hašler" looks like a Mac ö, so on its own it's refused -- but with any other Windows letter in
  // the file (here "Tomáš") it's imported.
  assert.equal(importOne(windows1252("First name,Last name\r\nKarel,Hašler\r\n")), "refused");
  assert.deepEqual(importOne(windows1252("First name,Last name\r\nKarel,Hašler\r\nTomáš,Novak\r\n")), {
    firstName: "Karel",
    lastName: "Hašler",
  });
});

// --- TS-254 item 3: Windows ’ between small letters -------------------------------------------------

test("TS-254: windows-1252 Ka’iulani, Ja’nae and Sha’nice are imported when the file shows it's a Windows file", () => {
  for (const first of ["Ka’iulani", "Ja’nae", "Sha’nice"]) {
    // "café" in a column the import doesn't even use is enough.
    const withCafe = windows1252(`First name,Last name,Notes\r\n${first},Smith,café\r\n`);
    assert.deepEqual(importOne(withCafe), { firstName: first.replace("’", "'"), lastName: "Smith" }, first);
    // So is another guest's O’Brien, or an accented name.
    const withObrien = windows1252(`First name,Last name\r\n${first},Smith\r\nSean,O’Brien\r\n`);
    assert.deepEqual(importOne(withObrien), { firstName: first.replace("’", "'"), lastName: "Smith" }, first);
    const withMuller = windows1252(`First name,Last name\r\n${first},Müller\r\n`);
    assert.deepEqual(importOne(withMuller), { firstName: first.replace("’", "'"), lastName: "Müller" }, first);
  }
  assert.equal(hasWindowsLetters([["Ana", "café"]]), true);
  assert.equal(hasWindowsLetters([["Sean", "O’Brien"]]), true);
  assert.equal(hasWindowsLetters([["Ana", "Lee"]]), false);
  // A Mac file is never taken for a Windows one: its "Mar’a" is still refused, even with other names
  // that have accents (Mac é is Ž, Mac Ö is …, Mac dotless ı is õ).
  assert.equal(importOne(macRoman("First name,Last name\r\nMaría,Lopez\r\nJosé,Öztürk\r\nAyse,Yıldız\r\n")), "refused");
  assert.equal(hasWindowsLetters(parseCsv(decodeCsvFile(macRoman("a,b\r\nJosé,Yıldız\r\n")).text).rows), false);
  // In a file with nothing else to go on, Mar’a (María) is still the Mac sign.
  assert.deepEqual(findMacRomanCell([["Mar’a", "Lopez"]], [0, 1], [0, 1]), { rowNumber: 1, column: 0 });
  assert.equal(findMacRomanCell([["Ka’iulani", "Lee"], ["Zoé", "Martin"]], [0, 1], [0, 1]), null);
});

// --- TS-248 item 3: windows-1252 punctuation in 80-9F -----------------------------------------------

test("TS-248: a Windows file with 'é … é …' (no-break space, ellipsis), or ’ ” after one, isn't refused as mixed formats", () => {
  for (const note of ["café … café …", "Zoé ’ Zoé ”", "née — née –", "été • été ™"]) {
    // "Müller" makes the file not valid UTF-8, so it's checked for mixed formats.
    const text = `First name,Last name,Notes\r\nAna,Müller,${note}\r\n`;
    const read = decodeCsvFile(windows1252(text));
    assert.equal(read.encoding, "windows-1252", note);
    assert.equal(read.text, text, note);
  }
});

// --- TS-248 item 1: a curly apostrophe in a sign-up name --------------------------------------------

test("TS-248: a sign-up name with a curly apostrophe (O’Brien from an iPhone) or a no-break space is accepted and saved plain", () => {
  const base = { email: "ana@example.com", password: "a-long-password" };
  for (const [typed, saved] of [
    ["Siobhan O’Brien", "Siobhan O'Brien"],
    ["D‘Arcy Lee", "D'Arcy Lee"],
    ["Kaʼiulani Lee", "Ka'iulani Lee"],
    ["Mary Ann Lee", "Mary Ann Lee"],
  ]) {
    const parsed = signupSchema.safeParse({ ...base, name: typed });
    assert.ok(parsed.success, typed);
    assert.equal(parsed.data.name, saved, typed);
  }
  // The other name rules still apply after it's made plain.
  assert.equal(signupSchema.safeParse({ ...base, name: "’Brien" }).success, false);
  assert.equal(signupSchema.safeParse({ ...base, name: "Ana2" }).success, false);
  assert.equal(signupSchema.safeParse({ ...base, name: "" }).success, false);
});
