// TS-222 / TS-223 / TS-225: unit tests for review-8 fixes -- import columns whose header starts
// with + - = @, a Side name that disagrees with the Side code, "Log out on all devices" from an
// ended session, APP_URL tidied, the Mac Roman check, spreadsheet row numbers, steadier timing
// tests, and hourly limits on the PDFs and the import preview. The database is replaced by a
// stand-in where one is needed, and a throwaway secret is set before lib/auth loads. Run with
// `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.JWT_SECRET = randomBytes(32).toString("hex");

const { parseCsv, toCsv, spreadsheetRowNumber, CsvParseError } = await import("../../../../packages/shared/src/csv");
const { parseGuestImportRow } = await import("../../../../packages/shared/src/guest-import-row");
const { sideMismatchMessage, guestSideLabel } = await import("../../../../packages/shared/src/guest-side");
const { looksLikeMacRoman, MAC_ENCODING_MESSAGE } = await import("../../../../packages/shared/src/text-decode");
const { appBaseUrl } = await import("../../../../packages/shared/src/app-url");
const { prepareImportCsv, mappedColumnMissingMessage } = await import("./guest-import-client");
const { signToken, secureScheme, ALREADY_SIGNED_OUT_EVERYWHERE_MESSAGE } = await import("./auth");
const { tooMuchWeddingWorkMessage } = await import("./limit-messages");
const { pool } = await import("@seatwise/db");
const { NextRequest } = await import("next/server");

const realQuery = pool.query.bind(pool);
afterEach(() => {
  (pool as unknown as { query: unknown }).query = realQuery;
});

const SIDES = { sideLabel1: "Bride", sideLabel2: "Groom" };

// --- TS-222 item 1: headers starting with + - = @ ------------------------------------------------

test("TS-222: columns whose header starts with + - = or @ survive the import's rebuilt file", () => {
  const file = "First name,Last name,Headcount,+1,-Notes,=Side,@Email\r\nAna,Lee,2,Sam Lee,Window seat,Groom,ana@example.com\r\n";
  const mapping = { firstName: "First name", lastName: "Last name", headcount: "Headcount", plusOneNames: "+1", notes: "-Notes", side: "=Side" };
  const prepared = prepareImportCsv(file, "utf-8", mapping);
  assert.ok("csv" in prepared, JSON.stringify(prepared));
  // What the server reads: the same header names the planner mapped, and the row's values.
  const { headers, rows } = parseCsv(prepared.csv);
  assert.deepEqual(headers, ["First name", "Last name", "Headcount", "+1", "-Notes", "=Side"]);
  const row = parseGuestImportRow(rows[0], headers, mapping, SIDES);
  assert.deepEqual(row.errors, []);
  assert.equal(row.data.plusOneNames, "Sam Lee");
  assert.equal(row.data.notes, "Window seat");
  assert.equal(row.data.side, "GROOM");
});

test("TS-222: a header that is only + - = @ round-trips through toCsv and parseCsv, as cells do", () => {
  const headers = ["+1", "-Notes", "=Side", "@Email", "'+already", "Plain"];
  assert.deepEqual(parseCsv(toCsv(headers, [["a", "b", "c", "d", "e", "f"]])).headers, headers);
  // A name mapped to such a column still reads: it used to fail "Missing required name".
  const prepared = prepareImportCsv("=First,@Last\r\nAna,Lee\r\n", "utf-8", { firstName: "=First", lastName: "@Last" });
  assert.ok("csv" in prepared);
  const parsed = parseCsv(prepared.csv);
  const row = parseGuestImportRow(parsed.rows[0], parsed.headers, { firstName: "=First", lastName: "@Last" }, SIDES);
  assert.deepEqual(row.errors, []);
  assert.equal(row.data.firstName, "Ana");
});

test("TS-222: a mapped column the file doesn't have is refused, not quietly left out", () => {
  const prepared = prepareImportCsv("First name,Last name\r\nAna,Lee\r\n", "utf-8", { firstName: "First name", lastName: "Last name", plusOneNames: "+1" });
  assert.deepEqual(prepared, { error: mappedColumnMissingMessage("+1") });
  assert.match(mappedColumnMissingMessage("+1"), /no column called "\+1"/);
});

// --- TS-222 item 2: Side vs Side code ---------------------------------------------------------

test("TS-222: an untouched export re-imports after the sides are renamed -- the Side code wins, with a warning", () => {
  // Exported while the sides were Bride / Groom, then renamed to Groom / Partner.
  const renamed = { sideLabel1: "Groom", sideLabel2: "Partner" };
  const mapping = { firstName: "First name", lastName: "Last name", side: "Side", sideCode: "Side code" };
  const headers = ["First name", "Last name", "Side", "Side code"];
  const exported = (code: "BRIDE" | "GROOM" | "BOTH") => ["Ana", "Lee", guestSideLabel(code, "Bride", "Groom"), code];
  for (const code of ["BRIDE", "GROOM", "BOTH"] as const) {
    const row = parseGuestImportRow(exported(code), headers, mapping, renamed);
    assert.deepEqual(row.errors, [], code);
    assert.equal(row.data.side, code, `${code} guests stay on their side`);
  }
  // The renamed side's rows ("Groom" now names the first side) say so, without stopping the row.
  const groom = parseGuestImportRow(exported("GROOM"), headers, mapping, renamed);
  assert.equal(groom.warnings.length, 1);
  assert.equal(groom.warnings[0], sideMismatchMessage("Groom", "GROOM", "Partner"));
});

test("TS-222: the mismatch advice never says to clear the Side code", () => {
  const message = sideMismatchMessage("Groom", "GROOM", "Partner");
  assert.doesNotMatch(message, /clear/i);
  assert.match(message, /Side code is used \(Partner\)/);
  assert.match(message, /change the Side code cell/);
});

test("TS-222: without a Side code the Side cell still decides, and a bad Side code is still an error", () => {
  const headers = ["F", "L", "Side", "Side code"];
  const both = { firstName: "F", lastName: "L", side: "Side", sideCode: "Side code" };
  assert.equal(parseGuestImportRow(["A", "B", "Groom", ""], headers, both, SIDES).data.side, "GROOM");
  const bad = parseGuestImportRow(["A", "B", "Groom", "SIDE A"], headers, both, SIDES);
  assert.match(bad.errors.join(" "), /Side code "SIDE A"/);
});

// --- TS-223 item 1: "Log out on all devices" from an ended session -----------------------------

test("TS-223: 'Log out on all devices' with no signed-in session answers 401 and says to sign in again", async () => {
  const { POST: logout } = await import("../app/api/v1/auth/logout/route");
  (pool as unknown as { query: unknown }).query = async (sql: string) => {
    throw new Error(`unexpected query: ${sql}`);
  };
  const res = await logout(
    new NextRequest("http://localhost/api/v1/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ everywhere: true }),
    })
  );
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: ALREADY_SIGNED_OUT_EVERYWHERE_MESSAGE });
  assert.equal(ALREADY_SIGNED_OUT_EVERYWHERE_MESSAGE, "You're already signed out here — sign in again, then use Log out on all devices.");
  // The cookie is still cleared.
  assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/i);
  // A plain "Log out" with no session is still fine (nothing to end here).
  const plain = await logout(new NextRequest("http://localhost/api/v1/auth/logout", { method: "POST" }));
  assert.equal(plain.status, 200);
});

// --- TS-225 item 1: APP_URL -------------------------------------------------------------------

test("TS-225: APP_URL is returned tidied (origin and path, no trailing slash)", () => {
  const prod = (APP_URL: string) => appBaseUrl({ NODE_ENV: "production", APP_URL });
  assert.equal(prod("HTTPS://Seatwise.App"), "https://seatwise.app");
  assert.equal(prod("https:seatwise.app"), "https://seatwise.app");
  assert.equal(prod("https://seatwise.app/"), "https://seatwise.app");
  assert.equal(prod("https://seatwise.app/app/"), "https://seatwise.app/app");
  assert.equal(prod("https://seatwise.app:443/"), "https://seatwise.app");
  assert.equal(appBaseUrl({ NODE_ENV: "development", APP_URL: "HTTP://LOCALHOST:4000/" }), "http://localhost:4000");
});

test("TS-225: the cookie's Secure flag reads the scheme as a browser does", () => {
  assert.equal(secureScheme("https://seatwise.app"), true);
  assert.equal(secureScheme("HTTPS://seatwise.app"), true);
  assert.equal(secureScheme("http://localhost:3000"), false);
  assert.equal(secureScheme("not an address"), false);
});

// --- TS-225 item 2: Mac Roman ---------------------------------------------------------------

test("TS-225: the Mac check catches an accented letter after a capital, and at a word's start", () => {
  for (const name of ["MŸller", "ƒloise", "‡ngel", "Ana ƒloise", "RenŽe"]) assert.equal(looksLikeMacRoman(name, true), true, name);
  for (const name of ["Željko Žižek", "HAŸ-LES-ROSES", "Œuvre", "ŠKODA", "Kašpar", "O’Brien", "Seatwise™", "5 ‰"]) {
    assert.equal(looksLikeMacRoman(name, true), false, name);
  }
});

// --- TS-225 item 3: row numbers ---------------------------------------------------------------

test("TS-225: import row numbers are the spreadsheet's (the header is row 1)", () => {
  assert.equal(spreadsheetRowNumber(1), 2);
  // The Mac message names the spreadsheet row: data row 2 is spreadsheet row 3.
  const prepared = prepareImportCsv("First name,Last name\r\nAna,Lee\r\nRenŽe,Lee\r\n", "windows-1252", { firstName: "First name", lastName: "Last name" });
  assert.deepEqual(prepared, { error: `${MAC_ENCODING_MESSAGE} (First seen in row 3, column "First name".)` });
  // The unclosed-quote message counts the same way.
  assert.throws(() => parseCsv('First name,Last name\r\nAna,Lee\r\n"Bo,Lee\r\n'), (err: unknown) => err instanceof CsvParseError && /in row 3 /.test(err.message));
});

// --- TS-225 item 6: hourly limits on the PDFs and the import preview ----------------------------

/** The database as a stand-in: one signed-in member of wedding "w", and every hourly count already at the limit. */
function overTheLimit() {
  (pool as unknown as { query: unknown }).query = async (sql: string) => {
    const s = sql.trim();
    if (/FROM "users"/.test(s)) {
      return { rows: [{ id: "u1", email: "u1@example.invalid", name: "u1", passwordHash: "x", sessionVersion: 0, emailVerifiedAt: new Date() }] };
    }
    if (/revoked_sessions/.test(s)) return { rows: [] };
    if (/^INSERT INTO "rate_limit_counters"/.test(s)) return { rows: [{ count: 1_000 }] };
    if (/^UPDATE "rate_limit_counters"/.test(s) || /^SELECT count FROM "rate_limit_counters"/.test(s) || /^DELETE FROM "rate_limit_counters"/.test(s)) {
      return { rows: [] };
    }
    if (/SELECT "ownerId" FROM "weddings"/.test(s)) return { rows: [{ ownerId: "u1" }] };
    if (/FROM "weddings"/.test(s)) return { rows: [{ id: "w", ownerId: "u1", name: "W" }] };
    if (/FROM "wedding_collaborators"/.test(s)) return { rows: [] };
    throw new Error(`unexpected query: ${s}`);
  };
}

test("TS-225: the three PDFs and the import preview have an hourly per-account limit", async () => {
  const token = await signToken({ sub: "u1", email: "u1@example.invalid", authTime: Math.floor(Date.now() / 1000), sessionVersion: 0 });
  const headers = { authorization: `Bearer ${token}` };
  const params = Promise.resolve({ weddingId: "w", planVersionId: "p" });
  for (const kind of ["chart", "lookup", "cards"]) {
    overTheLimit();
    const { GET } = await import(`../app/api/v1/weddings/[weddingId]/plan-versions/[planVersionId]/export/${kind}/route`);
    const res: Response = await GET(new NextRequest(`http://localhost/api/v1/weddings/w/plan-versions/p/export/${kind}`, { headers }), { params });
    assert.equal(res.status, 429, kind);
    assert.equal((await res.json()).error, tooMuchWeddingWorkMessage("pdfExport"), kind);
  }
  overTheLimit();
  const { POST: preview } = await import("../app/api/v1/weddings/[weddingId]/guests/import/preview/route");
  const res = await preview(
    new NextRequest("http://localhost/api/v1/weddings/w/guests/import/preview", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ csv: "First name,Last name\r\nAna,Lee\r\n", mapping: { firstName: "First name", lastName: "Last name" } }),
    }),
    { params: Promise.resolve({ weddingId: "w" }) }
  );
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, tooMuchWeddingWorkMessage("importPreview"));
});
