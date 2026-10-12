// TS-183: CI's schema drift check -- fails when schema.prisma and the migrations folder describe
// different databases (a migration hand-edited without the schema, or the other way round).
//
// It replays every migration into a scratch "shadow" database and asks Prisma what SQL would turn
// that into schema.prisma. The answer should be nothing -- except for one known, deliberate
// difference: the partial unique index "plan_versions_one_current_per_wedding" (see the comment on
// PlanVersion in schema.prisma). Prisma can't express a partial index, so it always proposes
// dropping it; that one line is allowed and anything else fails the check. TS-234: and the same
// for "wedding_invites_one_pending_per_email" (see WeddingInvite in schema.prisma).
//
// TS-200: this check BLOCKS. It ran report-only (continue-on-error) at first, in case the
// hand-written first migration (0001_init) disagreed with Prisma's defaults; the first CI runs
// reported no drift, so TS-192 removed continue-on-error -- a schema change without its migration
// (or the other way round) now fails CI.
//
// Usage (CI, after the e2e job's Postgres service is up):
//   SHADOW_DATABASE_URL=postgresql://.../seatwise_shadow pnpm --filter @seatwise/db check-schema-drift
// The shadow database is wiped by Prisma, so it must be a throwaway one on a local/CI server -- this
// creates it if it's missing and refuses anything that isn't local.

// TS-172: local databases only (see local-only.ts) -- the shadow database is created on that server.
import "./local-only";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { isLocalDatabase } from "./local-only";

/** SQL statements Prisma may propose that are known and accepted. */
const ALLOWED_DIFF_LINES = [
  /^DROP INDEX "plan_versions_one_current_per_wedding";$/,
  // TS-234: the second hand-written partial index (see WeddingInvite in schema.prisma).
  /^DROP INDEX "wedding_invites_one_pending_per_email";$/,
];

/** The statements in Prisma's proposed script that aren't allowed (comments and blank lines ignored). */
export function unexpectedDriftLines(script: string): string[] {
  return script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("--"))
    .filter((l) => !ALLOWED_DIFF_LINES.some((re) => re.test(l)));
}

async function ensureShadowDatabase(shadowUrl: string): Promise<void> {
  const name = new URL(shadowUrl).pathname.replace(/^\//, "");
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("The shadow database name must be plain lowercase letters, digits or _.");
  const admin = new URL(shadowUrl);
  admin.pathname = "/postgres";
  admin.search = "";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}

async function main() {
  const shadowUrl = process.env.SHADOW_DATABASE_URL;
  if (!shadowUrl) throw new Error("SHADOW_DATABASE_URL is not set.");
  if (!isLocalDatabase(shadowUrl)) throw new Error("SHADOW_DATABASE_URL must be a local/CI database -- Prisma wipes it.");
  if (shadowUrl === process.env.DATABASE_URL) throw new Error("SHADOW_DATABASE_URL must not be the app's own database.");
  await ensureShadowDatabase(shadowUrl);

  const prismaDir = __dirname;
  const script = execFileSync(
    "pnpm",
    [
      "exec",
      "prisma",
      "migrate",
      "diff",
      "--from-migrations",
      path.join(prismaDir, "migrations"),
      "--to-schema-datamodel",
      path.join(prismaDir, "schema.prisma"),
      "--shadow-database-url",
      shadowUrl,
      "--script",
    ],
    { encoding: "utf8", cwd: path.join(prismaDir, ".."), stdio: ["ignore", "pipe", "inherit"] }
  );

  const unexpected = unexpectedDriftLines(script);
  // In GitHub Actions, the result also goes on the run's summary page.
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      unexpected.length > 0
        ? `## Schema drift found\n\nPrisma would run this to turn the migrations into schema.prisma:\n\n\`\`\`sql\n${script}\n\`\`\`\n`
        : "## No schema drift\n\nThe migrations and schema.prisma match (apart from the known partial index).\n"
    );
  }
  if (unexpected.length > 0) {
    console.error("schema.prisma and the migrations don't match. Prisma would run:\n");
    console.error(script);
    console.error(
      "\nAdd a migration for the schema change (or update schema.prisma to match the migration). " +
        "Only DROP INDEX \"plan_versions_one_current_per_wedding\" and \"wedding_invites_one_pending_per_email\" are expected here."
    );
    process.exitCode = 1;
    return;
  }
  console.log("No schema drift: the migrations and schema.prisma match (apart from the known partial index).");
}

main().catch((err) => {
  console.error(`Drift check failed to run: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
