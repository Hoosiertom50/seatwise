// TS-258: unit tests for the leftover small bugs -- the "Delete this wedding" confirm box takes a
// saved name longer than today's limit, a copy's name stays within the limit, and saving settings
// at the moment of a hand-off never answers with the new owner's note. The database is replaced
// by a scripted stand-in (the review-10 pattern). The spaced-out web address is covered in
// name-rules.test.mts, and the long-name delete on screen by
// e2e/tests/collaboration.a-long-wedding-name-can-be-confirmed-for-delete.spec.ts. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.JWT_SECRET = randomBytes(32).toString("hex");

const db = await import("@seatwise/db");
const { pool } = db;
const { signToken } = await import("./auth");
const { NextRequest } = await import("next/server");
const { deleteConfirmMaxLength } = await import("./leave-wedding");
const { FIELD_LIMITS, copiedWeddingName } = await import("@seatwise/shared");

// ---- item 1: a long saved name can be typed in full ----

test("TS-258: the delete confirm box takes a saved name longer than the limit", () => {
  const limit = FIELD_LIMITS.weddingName;
  assert.equal(deleteConfirmMaxLength(limit, "Ana and Bo"), limit);
  assert.equal(deleteConfirmMaxLength(limit, "x".repeat(limit)), limit);
  assert.equal(deleteConfirmMaxLength(limit, "x".repeat(limit + 57)), limit + 57);
});

test("TS-258: a copy of a wedding with a name at (or over) the limit is named within the limit", () => {
  const limit = FIELD_LIMITS.weddingName;
  for (const original of ["A".repeat(limit), "B".repeat(limit + 40), `${"é".repeat(limit - 3)} xy`]) {
    const name = copiedWeddingName(original);
    assert.ok(name.length <= limit, `${name.length} > ${limit}`);
    assert.ok(name.endsWith(" - copy"));
  }
});

// ---- item 3: a settings save at the moment of a hand-off ----

type Rows = Record<string, unknown>[];
const realConnect = pool.connect.bind(pool);
const realQuery = pool.query.bind(pool);

afterEach(() => {
  (pool as unknown as { connect: unknown }).connect = realConnect;
  (pool as unknown as { query: unknown }).query = realQuery;
});

const NEW_OWNERS_NOTE = "new owner's private note";

/**
 * A wedding owned by owner-1. `updateLands`: the settings save lands (otherwise it's refused for
 * its revision -- a conflict). `handOff`: right after that, the wedding passes to owner-2, before
 * the route reads it again.
 */
function scriptedWedding(opts: { updateLands: boolean; handOff: boolean }) {
  let ownerId = "owner-1";
  const run = async (sql: string, p: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    let rows: Rows = [];
    if (/FROM "users" WHERE id = \$1/.test(flat)) {
      rows = [{ id: p[0], email: `${p[0]}@example.invalid`, name: "Pat Lee", sessionVersion: 0, emailVerifiedAt: new Date() }];
    } else if (/^SELECT "ownerId" FROM "weddings" WHERE id = \$1$/.test(flat)) {
      rows = [{ ownerId }];
    } else if (/^SELECT "settingsRevision" FROM "weddings" WHERE id = \$1 AND "ownerId" = \$2/.test(flat)) {
      // Still the owner when the update was refused for its revision -- the hand-off comes next.
      rows = [{ settingsRevision: 9 }];
      if (opts.handOff) ownerId = "owner-2";
    } else if (/^UPDATE "weddings" SET/.test(flat)) {
      if (opts.updateLands) {
        rows = [{}];
        if (opts.handOff) ownerId = "owner-2";
      }
    } else if (/FROM "weddings" w/.test(flat) && /WHERE w\.id = \$1$/.test(flat)) {
      rows = [
        {
          id: "w1",
          ownerId,
          name: "Ana and Bo",
          eventDate: "2030-06-01",
          venueName: null,
          note: ownerId === "owner-1" ? "first owner's note" : NEW_OWNERS_NOTE,
          status: "PLANNING",
          emailNotificationsEnabled: true,
          sideMixing: "MIX",
          sideLabel1: "Bride",
          sideLabel2: "Groom",
          rsvpCutoffDate: null,
          settingsRevision: 9,
          createdAt: new Date(),
          updatedAt: new Date(),
          guestCount: 0,
          peopleCount: 0,
          attendingCount: 0,
        },
      ];
    }
    return { rows, rowCount: rows.length };
  };
  (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release: () => {} });
  (pool as unknown as { query: unknown }).query = run;
}

async function patchVenue(): Promise<Response> {
  const token = await signToken({ sub: "owner-1", email: "owner-1@example.invalid", authTime: Math.floor(Date.now() / 1000), sessionVersion: 0 });
  const { PATCH } = await import("../app/api/v1/weddings/[weddingId]/route");
  return PATCH(
    new NextRequest("http://localhost/api/v1/weddings/w1", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ venueName: "The Barn", expectedRevision: 8 }),
    }),
    { params: Promise.resolve({ weddingId: "w1" }) }
  );
}

test("TS-258: a settings conflict at the moment of a hand-off answers 403, without the new owner's note", async () => {
  scriptedWedding({ updateLands: false, handOff: true });
  const res = await patchVenue();
  const text = await res.text();
  assert.equal(res.status, 403, text);
  assert.ok(!text.includes(NEW_OWNERS_NOTE), text);
  assert.match(JSON.parse(text).error, /aren't its owner any more/);
});

test("TS-258: a settings conflict for the owner still shows the latest settings, note included", async () => {
  scriptedWedding({ updateLands: false, handOff: false });
  const res = await patchVenue();
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.wedding.note, "first owner's note");
  assert.equal(body.wedding.ownerId, "owner-1");
});

test("TS-258: a save read back after a hand-off leaves out the new owner's note", async () => {
  scriptedWedding({ updateLands: true, handOff: true });
  const res = await patchVenue();
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.ok(!text.includes(NEW_OWNERS_NOTE), text);
  assert.equal("note" in JSON.parse(text).wedding, false);
});
