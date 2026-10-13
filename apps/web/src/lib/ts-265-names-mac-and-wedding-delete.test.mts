// TS-265: unit tests for the thirteenth review's fixes --
//   1. names with an Indic initial written without a space ("இரா.செழியன்", "श्री.रामचंद्र", "आर.किरण")
//      are accepted again, while look-alike dots ("paypalꓸcom") and fullwidth, math, superscript
//      and small forms ("x.ｃｏｍ", "evil . ｃｏｍ", "evil﹒com") are refused as web addresses; the
//      check stays fast on long text;
//   2. Mac í after a vowel ("Elo’sa", "Tha’s", "Ra’ssa", "Ru’z") is caught again on import, while the
//      windows-1252 names with ’ (Ja’nae, Da’shawn, Kenya’, Ka’iulani...) still import;
//   3. a wedding delete locks all its plans FOR UPDATE before deleting (current plan first), and
//      when an older plan is held by a change waiting for the current one it lets go and starts
//      again instead of deadlocking. Scripted stand-in (always runs) plus one check on the local
//      database (runs only when the database in packages/db/.env, or DATABASE_URL, is on this
//      machine and reachable -- skipped otherwise, e.g. in CI's unit job; its rows are deleted
//      afterwards). Never connects anywhere but localhost.
// Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";

const { looksLikeWebAddress, looksLikePhoneNumber } = await import("../../../../packages/shared/src/validation");
const { signupSchema } = await import("../../../../packages/shared/src/schemas/auth");
const { createGuestSchema } = await import("../../../../packages/shared/src/schemas/guest");
const { weddingNameField } = await import("../../../../packages/shared/src/schemas/wedding");
const { emailSafePersonName, emailSafeWeddingName } = await import("../../../../packages/shared/src/email-safe-names");
const { emailSafeNotificationText } = await import("../../../../packages/db/src/queries/notifications");
const { parseCsv } = await import("../../../../packages/shared/src/csv");
const { parseGuestImportRow } = await import("../../../../packages/shared/src/guest-import-row");
const { decodeCsvFile, looksLikeMacRoman, MAC_ENCODING_MESSAGE } = await import("../../../../packages/shared/src/text-decode");
const { prepareImportCsv } = await import("./guest-import-client");
const db = await import("@seatwise/db");
const { pool, deleteWeddingForOwner } = db;

const NEUTRAL = "There's an update on a wedding you're part of — open Seatwise to see it.";

function guestErrors(lastName: string): string[] {
  const r = createGuestSchema.safeParse({ firstName: "Ann", lastName });
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

// --- 1) names: Indic initials, look-alike dots, compatibility forms ----------------------------------

// Real names written with an initial and no space -- a Tamil or Hindi initial ends in a vowel sign,
// which is a mark, not a letter.
const INDIC_INITIALS = [
  "இரா.செழியன்",
  "கி.ராஜநாராயணன்",
  "மு.கருணாநிதி",
  "ஆர்.கிருஷ்ணன்",
  "க.மு.சுப்ரமணியம்",
  "श्री.रामचंद्र",
  "आर.किरण",
  "एस.के.शर्मा",
  "डॉ.किरण",
];

test("TS-265: names with an Indic initial and no space are accepted again", () => {
  for (const name of INDIC_INITIALS) {
    assert.equal(looksLikeWebAddress(name), false, name);
    assert.deepEqual(guestErrors(name), [], name);
    assert.equal(createGuestSchema.parse({ firstName: name, lastName: "Kumar" }).firstName, name, name);
    assert.equal(signupSchema.safeParse({ name, email: "a@b.co", password: "Abcdefgh1234!xyz" }).success, true, name);
    assert.equal(weddingNameField.safeParse(`${name} & Lee`).success, true, name);
    assert.equal(emailSafePersonName(name), name, name);
    assert.equal(emailSafeNotificationText(`${name} is coming.`), `${name} is coming.`, name);
  }
});

test("TS-265: other real names, accented or with a dot below, still pass", () => {
  const names = [
    "José", "José".normalize("NFD"), "Thị Lan Nguyễn", "Thịnh", "Ngọc", "Ngọc".normalize("NFD"), "Kṛṣṇa", "Adébáyọ̀", "Ọlá",
    "Muḥammad", "Ó Súilleabháin", "J.R. Smith", "St. Clair", "J. R. R. Smith", "Lee . Kim", "Ana B. De Souza", "J. Link",
    "Mary-Kate", "D'Arcy", "Zoë", "Łukasz", "Dvořák", "Иванова", "Ελένη", "김철수", "山田太郎", "ร.ศักดิ์ชัย",
  ];
  for (const name of names) {
    assert.equal(looksLikeWebAddress(name), false, name);
    assert.deepEqual(guestErrors(name), [], name);
  }
  for (const title of ["Smith-Jones Wedding, Est. 2026", "Alex & Jordan's Wedding", "Thị Lan & José 10-5-26"]) {
    assert.equal(weddingNameField.safeParse(title).success, true, title);
    assert.equal(emailSafeWeddingName(title), title, title);
  }
});

// PR #114 review: a middle dot is how Japanese and Catalan names are written. The name fields'
// letters-only rule refuses it on its own; the web-address check doesn't count it as a dot except
// before the endings scam links use, so text with one isn't swapped for the neutral notification.
test("TS-265: a middle dot between names isn't a web address (only before com, net...)", () => {
  for (const name of ["ジョン・スミス", "エミリー・ブラウン", "Gal·la", "Pere·Joan", "Mary・Jane", "Paul·lí"]) {
    assert.equal(looksLikeWebAddress(name), false, name);
    assert.equal(emailSafeNotificationText(`${name} was added to Table 3`), `${name} was added to Table 3`, name);
  }
  for (const v of ["paypal・com", "evil·net", "shop・xyz"]) assert.equal(looksLikeWebAddress(v), true, v);
});

test("TS-265: every name in the sample import file still passes", () => {
  const csv = readFileSync(path.join(import.meta.dirname, "../../../../docs/sample-guest-import.csv"), "utf8");
  const { headers, rows } = parseCsv(csv.replace(/^﻿/, ""));
  const first = headers.indexOf("First Name");
  const last = headers.indexOf("Last Name");
  assert.ok(rows.length >= 20);
  for (const row of rows) {
    for (const name of [row[first], row[last]]) {
      assert.deepEqual(guestErrors(name), [], name);
      assert.deepEqual(guestErrors(name.normalize("NFD")), [], `${name} (NFD)`);
    }
  }
});

// What the review got past every name rule (and what's close to it).
const LOOKS_LIKE_A_WEB_ADDRESS = [
  "paypalꓸcom", // U+A4F8 Lisu tone letter (a letter)
  "paypalꞏcom", // U+A78F Latin sinological dot (a letter)
  "paypalᐧcom", // U+1427 Canadian syllabics final middle dot (a letter)
  "x.ｃｏｍ", // fullwidth
  "x.\u{1D41C}\u{1D428}\u{1D426}", // math bold
  "x.ᶜᵒᵐ", // superscript
  "evil . ｃｏｍ",
  "evilꓸ ｃｏｍ",
  "evil․com", // U+2024 one dot leader
  "evil﹒com", // U+FE52 small full stop
  "evil·com", // U+00B7 middle dot
  "evil・com", // U+30FB katakana middle dot
  "evil⸱com", // U+2E31 word separator middle dot
  "ev܁com", // U+0701 Syriac full stop
  "eviḷcom", // a dot below between letters (saved as "eviḷcom")
  "evil़com", // a nukta (a dot below) after a Latin letter
  // A dot-like mark that belongs to the letter's own script (and so is kept with it) -- PR #114.
  "\u0627\u065Ccom", // Arabic
  "\u0915\u093Ccom", // Devanagari nukta
  "\u0A15\u0A3Ccom", // Gurmukhi nukta
  "evil-.com",
  "x-.com",
  // still caught, as before
  "evil.com", "evil . com", "evil.c͏om", "evil.c̣om", "evil.ćom", "evil̸.com",
];

test("TS-265: look-alike dots and compatibility forms are refused as web addresses", () => {
  for (const v of LOOKS_LIKE_A_WEB_ADDRESS) {
    assert.equal(looksLikeWebAddress(v), true, v);
    assert.equal(emailSafePersonName(v), null, v);
    assert.equal(emailSafeWeddingName(v), null, v);
    assert.equal(emailSafeNotificationText(`Ann ${v} was added to Table 3`), NEUTRAL, v);
    assert.notDeepEqual(guestErrors(v), [], v);
    assert.equal(weddingNameField.safeParse(`Verify at ${v}`).success, false, v);
  }
  // The letter-like dots pass the name pattern, so it's the web-address check that refuses them.
  for (const v of ["paypalꓸcom", "paypalꞏcom", "paypalᐧcom", "x.ｃｏｍ", "evil . ｃｏｍ"]) {
    assert.ok(guestErrors(v).includes("Can't look like a web address"), v);
  }
});

test("TS-265: superscript digits count as a phone number", () => {
  assert.equal(looksLikePhoneNumber("Call ⁸⁰⁰⁵⁵⁵¹²³⁴"), true);
  assert.equal(weddingNameField.safeParse("Call ⁸⁰⁰⁵⁵⁵¹²³⁴").success, false);
  assert.equal(looksLikePhoneNumber("Est. 2026"), false);
});

test("TS-265: the web-address and phone checks stay fast on long text (no quadratic slow-down)", () => {
  // The old check read a long run of letters once from every letter: a 4,000-character run of
  // fullwidth letters took about 0.4 s, of letter + look-alike dot about 0.3 s.
  for (const len of [200, 4_000, 20_000]) {
    for (const text of ["ａ".repeat(len), "aꓸ".repeat(len / 2), "a-ꓸ".repeat(len / 3), "இரா".repeat(len / 3), "ḷ".repeat(len / 2), "a-".repeat(len / 2), "1 ".repeat(len / 2)]) {
      const t = performance.now();
      looksLikeWebAddress(text);
      looksLikePhoneNumber(text);
      emailSafeNotificationText(text);
      assert.ok(performance.now() - t < 250, `${len} characters (${text.slice(0, 3)}...) took ${performance.now() - t} ms`);
    }
  }
});

// --- 2) Mac í after a vowel ----------------------------------------------------------------------------

function bytesFor(encoding: string, text: string): Uint8Array {
  const decoder = new TextDecoder(encoding);
  const byChar = new Map<string, number>();
  for (let b = 0; b < 256; b++) byChar.set(decoder.decode(new Uint8Array([b])), b);
  return new Uint8Array([...text].map((ch) => byChar.get(ch)!));
}
const NAMES = { firstName: "First name", lastName: "Last name" };
const SIDES = { sideLabel1: "Bride", sideLabel2: "Groom" };

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

test("TS-265: Mac í after a vowel is caught again (Eloísa, Thaís, Raíssa, Moíses, Ruíz...)", () => {
  for (const name of ["Eloísa", "Heloísa", "Thaís", "Laís", "Raíssa", "Moíses", "Ruíz", "Maíz", "Luís", "Luísa"]) {
    // As a windows-1252 file shows it: Mac í is ’.
    assert.equal(looksLikeMacRoman(name.replace("í", "’"), true, true, false), true, name);
    // From real Mac Roman bytes -- before, "Elo'sa" was saved without a word.
    assert.equal(importOne(bytesFor("macintosh", `First name,Last name\r\n${name},Lee\r\n`)), "refused", name);
    assert.equal(importOne(bytesFor("macintosh", `First name,Last name\r\nAna,${name}\r\n`)), "refused", name);
  }
});

test("TS-265: windows-1252 names with ’ still import (Ja’nae, Da’shawn, Ta’kia, Kenya’, Andre’, Rene’, Ka’iulani)", () => {
  for (const name of ["Ja’nae", "Da’shawn", "Ta’kia", "Kenya’", "Andre’", "Rene’", "Ka’iulani", "La’shawn", "Ke’shawn", "o’sullivan", "o’shea", "a’sante"]) {
    assert.equal(looksLikeMacRoman(name, true, true, false), false, name);
    assert.deepEqual(
      importOne(bytesFor("windows-1252", `First name,Last name\r\n${name},Lee\r\n`)),
      { firstName: name.replace("’", "'"), lastName: "Lee" },
      name
    );
  }
});

// --- 3) the wedding delete locks its plans first --------------------------------------------------

const realConnect = pool.connect.bind(pool);
afterEach(() => {
  (pool as unknown as { connect: unknown }).connect = realConnect;
});

/** A stand-in connection; `older` answers the older plans' lock (throw to refuse it). */
function scriptedDelete(older: (attempt: number) => void): string[] {
  const statements: string[] = [];
  let attempt = 0;
  (pool as unknown as { connect: unknown }).connect = async () => ({
    query: async (sql: string) => {
      const flat = sql.replace(/\s+/g, " ").trim();
      statements.push(flat);
      if (/FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/.test(flat)) return { rows: [{ id: "w1", ownerId: "owner-1" }], rowCount: 1 };
      if (/"isCurrent" FOR UPDATE$/.test(flat)) return { rows: [{ id: "p-current" }], rowCount: 1 };
      if (/NOT "isCurrent" ORDER BY id FOR UPDATE NOWAIT$/.test(flat)) older(++attempt);
      if (/^DELETE FROM "weddings"/.test(flat)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  });
  return statements;
}

const LOCK_ORDER = [
  /^SELECT id, "ownerId" FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE$/,
  /^SELECT id FROM "plan_versions" WHERE "weddingId" = \$1 AND "isCurrent" FOR UPDATE$/,
  /^SELECT id FROM "plan_versions" WHERE "weddingId" = \$1 AND NOT "isCurrent" ORDER BY id FOR UPDATE NOWAIT$/,
  /pg_advisory_xact_lock/,
  /^DELETE FROM "weddings" WHERE id = \$1 AND "ownerId" = \$2$/,
  /^COMMIT$/,
];

test("TS-265: a wedding delete takes the wedding, the current plan FOR UPDATE, then the older plans, then deletes", async () => {
  const statements = scriptedDelete(() => {});
  assert.equal(await deleteWeddingForOwner("w1", "owner-1"), "deleted");
  const positions = LOCK_ORDER.map((re) => statements.findIndex((s) => re.test(s)));
  assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), statements.join(" | "));
  // The weaker lock a plan change takes is never taken (and then made stronger) by the delete.
  assert.equal(statements.some((s) => /FOR NO KEY UPDATE$/.test(s) && s.includes("plan_versions")), false);
});

test("TS-265: when an older plan is held, the delete rolls back and starts again; after 5 tries it's a 409 'try again'", async () => {
  const busy = () => {
    throw Object.assign(new Error("could not obtain lock on row in relation \"plan_versions\""), { code: "55P03" });
  };
  let statements = scriptedDelete((attempt) => {
    if (attempt < 3) busy();
  });
  assert.equal(await deleteWeddingForOwner("w1", "owner-1"), "deleted");
  assert.equal(statements.filter((s) => s === "ROLLBACK").length, 2);
  assert.equal(statements.filter((s) => s.startsWith("DELETE")).length, 1);

  statements = scriptedDelete(busy);
  await assert.rejects(deleteWeddingForOwner("w1", "owner-1"), (err: Error & { code?: string }) => err.code === "40001");
  assert.equal(statements.filter((s) => /FOR UPDATE NOWAIT$/.test(s)).length, 5);
  assert.equal(statements.some((s) => s.startsWith("DELETE")), false);

  // Any other error is not retried.
  statements = scriptedDelete(() => {
    throw Object.assign(new Error("boom"), { code: "XX000" });
  });
  await assert.rejects(deleteWeddingForOwner("w1", "owner-1"), (err: Error & { code?: string }) => err.code === "XX000");
  assert.equal(statements.filter((s) => /FOR UPDATE NOWAIT$/.test(s)).length, 1);
});

// Only ever a database on this machine (the same hosts the packages/db scripts accept).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function localDatabaseUrl(): string | null {
  let url = process.env.DATABASE_URL;
  if (!url) {
    try {
      const env = readFileSync(path.join(import.meta.dirname, "../../../../packages/db/.env"), "utf8");
      url = /^DATABASE_URL="?([^"\n]+)"?/m.exec(env)?.[1];
    } catch {
      return null;
    }
  }
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!LOCAL_HOSTS.has(parsed.hostname)) return null;
    parsed.searchParams.delete("schema");
    return parsed.toString();
  } catch {
    return null;
  }
}

type PgClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect: () => Promise<void>;
  end: () => Promise<void>;
};
const pg = createRequire(import.meta.url)("pg") as { Client: new (o: { connectionString: string; connectionTimeoutMillis: number }) => PgClient };
const localUrl = localDatabaseUrl();

async function localClient(): Promise<PgClient> {
  const client = new pg.Client({ connectionString: localUrl!, connectionTimeoutMillis: 2000 });
  await client.connect();
  return client;
}

async function localSkipReason(): Promise<string | false> {
  if (!localUrl) return "no local database configured (DATABASE_URL must point at localhost)";
  try {
    const client = await localClient();
    try {
      await client.query(`SELECT 1 FROM "plan_versions" LIMIT 0`);
    } finally {
      await client.end();
    }
    return false;
  } catch (err) {
    return `local database not reachable (${(err as Error & { code?: string }).code ?? (err as Error).message})`;
  }
}
const skip = await localSkipReason();

test("TS-265: on the local database, a delete doesn't deadlock with a change holding an older plan while it waits for the current one", { skip }, async () => {
  // The change: it was waiting for the current plan when a Generate replaced it, so Postgres left it
  // holding the old (now older) plan's row while it asks again for the current one. Before, the
  // delete held the current plan and waited for the older one, the change waited for the current
  // one, and Postgres broke the deadlock by failing one of them (after about a second).
  const setup = await localClient();
  const change = await localClient();
  const ownerId = randomUUID();
  const weddingId = randomUUID();
  const olderPlan = randomUUID();
  const currentPlan = randomUUID();
  // The delete runs on its own real connection(s) to the same local database.
  (pool as unknown as { connect: unknown }).connect = async () => {
    const c = await localClient();
    return { query: c.query.bind(c), release: () => void c.end() };
  };
  try {
    await setup.query(
      `INSERT INTO "users" (id, email, "passwordHash", name, "updatedAt") VALUES ($1, $2, 'x', 'TS-265 test', now())`,
      [ownerId, `ts-265-${ownerId}@example.invalid`]
    );
    await setup.query(`INSERT INTO "weddings" (id, "ownerId", name, "updatedAt") VALUES ($1, $2, 'TS-265 test', now())`, [weddingId, ownerId]);
    await setup.query(
      `INSERT INTO "plan_versions" (id, "weddingId", "versionNumber", "isCurrent") VALUES ($1, $3, 1, false), ($2, $3, 2, true)`,
      [olderPlan, currentPlan, weddingId]
    );

    await change.query("BEGIN");
    await change.query(`SET LOCAL statement_timeout = '5s'`);
    await change.query(`SELECT id FROM "plan_versions" WHERE id = $1 FOR NO KEY UPDATE`, [olderPlan]);
    const deleting = deleteWeddingForOwner(weddingId, ownerId).then(
      (v) => ({ ok: true as const, v }),
      (e: Error & { code?: string }) => ({ ok: false as const, code: e.code })
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    const started = performance.now();
    const { rows } = await change.query(`SELECT id FROM "plan_versions" WHERE "weddingId" = $1 AND "isCurrent" FOR NO KEY UPDATE`, [weddingId]);
    assert.equal(rows[0]?.id, currentPlan);
    assert.ok(performance.now() - started < 900, `the change waited ${performance.now() - started} ms`);
    await change.query("COMMIT");

    assert.deepEqual(await deleting, { ok: true, v: "deleted" });
    const left = await setup.query(`SELECT 1 FROM "plan_versions" WHERE "weddingId" = $1`, [weddingId]);
    assert.equal(left.rowCount, 0);
  } finally {
    await change.query("ROLLBACK").catch(() => {});
    await change.end().catch(() => {});
    await setup.query(`DELETE FROM "weddings" WHERE id = $1`, [weddingId]).catch(() => {});
    await setup.query(`DELETE FROM "users" WHERE id = $1`, [ownerId]).catch(() => {});
    await setup.end().catch(() => {});
  }
});
