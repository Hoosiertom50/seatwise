// TS-205: the per-account hourly limits on heavy work inside a wedding (Generate, Restore, import,
// save as template, comments): a try that succeeds counts, a refused or failed one is given back,
// and the refusal says plainly what there was a lot of. The rate-limit table is replaced by an
// in-memory stand-in. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";

const { pool } = await import("@seatwise/db");
const { limitedWeddingWork, WEDDING_WORK_LIMITS, weddingWorkKey } = await import("./rate-limit");
const { tooMuchWeddingWorkMessage } = await import("./limit-messages");

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
    if (/^SELECT count FROM "rate_limit_counters"/.test(sql.trim())) return { rows: [] }; // nothing in the previous hour
    if (/^DELETE FROM "rate_limit_counters"/.test(sql.trim())) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  };
}
afterEach(() => {
  (pool as unknown as { query: unknown }).query = realQuery;
});
const total = () => [...counts.values()].reduce((a, b) => a + b, 0);

test("the hourly limits and their plain messages", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(WEDDING_WORK_LIMITS).map(([k, v]) => [k, [v.limit, v.windowSeconds]])),
    {
      generate: [60, 3600],
      restore: [60, 3600],
      importCommit: [30, 3600],
      saveTemplate: [20, 3600],
      comment: [120, 3600],
      // TS-225
      pdfExport: [60, 3600],
      importPreview: [60, 3600],
    }
  );
  assert.equal(tooMuchWeddingWorkMessage("pdfExport"), "You've made a lot of PDFs in the last hour — please wait a while and try again.");
  assert.equal(tooMuchWeddingWorkMessage("importPreview"), "You've previewed a lot of guest files in the last hour — please wait a while and try again.");
  assert.equal(tooMuchWeddingWorkMessage("generate"), "You've made a lot of seating plans in the last hour — please wait a while and try again.");
  assert.equal(tooMuchWeddingWorkMessage("comment"), "You've posted a lot of comments in the last hour — please wait a while and try again.");
  assert.notEqual(weddingWorkKey("generate", "u1"), weddingWorkKey("restore", "u1"));
});

test("a try that succeeds counts; one that fails or throws is given back", async () => {
  fakeCounters();
  await limitedWeddingWork("generate", "u1", async () => NextResponse.json({ ok: true }, { status: 201 }));
  assert.equal(total(), 1);
  await limitedWeddingWork("generate", "u1", async () => NextResponse.json({ error: "Add some guests first" }, { status: 422 }));
  assert.equal(total(), 1);
  await assert.rejects(limitedWeddingWork("generate", "u1", async () => Promise.reject(new Error("boom"))));
  assert.equal(total(), 1);
});

test("past the limit it's refused with the plain message, the work never runs, and the refusal isn't counted", async () => {
  fakeCounters();
  const { limit } = WEDDING_WORK_LIMITS.saveTemplate;
  for (let i = 0; i < limit; i++) {
    const ok = await limitedWeddingWork("saveTemplate", "u1", async () => NextResponse.json({}, { status: 201 }));
    assert.equal(ok.status, 201);
  }
  let ran = false;
  const refused = await limitedWeddingWork("saveTemplate", "u1", async () => {
    ran = true;
    return NextResponse.json({}, { status: 201 });
  });
  assert.equal(refused.status, 429);
  assert.equal(ran, false);
  assert.equal((await refused.json()).error, tooMuchWeddingWorkMessage("saveTemplate"));
  assert.ok(Number(refused.headers.get("Retry-After")) > 0);
  assert.equal(total(), limit);
  // Another account, and another kind of work, have their own counts.
  assert.equal((await limitedWeddingWork("saveTemplate", "u2", async () => NextResponse.json({}, { status: 201 }))).status, 201);
  assert.equal((await limitedWeddingWork("comment", "u1", async () => NextResponse.json({}, { status: 201 }))).status, 201);
});
