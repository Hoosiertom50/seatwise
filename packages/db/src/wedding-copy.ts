import { decryptTextWithSecret, encryptTextWithSecret } from "./crypto";

// TS-144: copying whole weddings from one database to another (Tom's local weddings -> his
// account on the live site). This file is the pure part -- which tables, in what order, and how
// each row is changed on the way -- so it can be unit-tested without a database. The script that
// reads and writes is packages/db/prisma/copy-weddings-to-production.ts.

type Row = Record<string, unknown>;

/**
 * Every table holding a wedding's own data, parent-first so foreign keys are satisfied on insert.
 * Deliberately left out: notifications (about the source accounts), collaborators and invites
 * (people on the source system), and seating templates (owned by an account, not a wedding).
 */
export const WEDDING_COPY_TABLES: { table: string; where: string; orderBy?: string }[] = [
  { table: "weddings", where: `id = ANY($1::text[])` },
  { table: "seating_tables", where: `"weddingId" = ANY($1::text[])` },
  { table: "guests", where: `"weddingId" = ANY($1::text[])` },
  { table: "guest_relationships", where: `"weddingId" = ANY($1::text[])` },
  {
    table: "restricted_table_guests",
    where: `"tableId" IN (SELECT id FROM "seating_tables" WHERE "weddingId" = ANY($1::text[]))`,
  },
  // restoredFromId points at another version of the same wedding: oldest first.
  { table: "plan_versions", where: `"weddingId" = ANY($1::text[])`, orderBy: `"createdAt", id` },
  {
    table: "seat_assignments",
    where: `"planVersionId" IN (SELECT id FROM "plan_versions" WHERE "weddingId" = ANY($1::text[]))`,
  },
  {
    table: "change_history_entries",
    where: `"planVersionId" IN (SELECT id FROM "plan_versions" WHERE "weddingId" = ANY($1::text[]))`,
  },
  { table: "rule_weight_configs", where: `"weddingId" = ANY($1::text[])` },
  { table: "timeline_entries", where: `"weddingId" = ANY($1::text[])` },
  { table: "vendors", where: `"weddingId" = ANY($1::text[])` },
  // parentCommentId points at another comment: oldest first.
  { table: "comments", where: `"weddingId" = ANY($1::text[])`, orderBy: `"createdAt", id` },
];

export interface CopyOptions {
  /** The account that owns the weddings on the source system. */
  sourceOwnerId: string;
  /** The account that will own them on the target system. */
  targetOwnerId: string;
  /** The source's ENCRYPTION_KEY (or the dev key), to read guest notes. */
  sourceSecret: string;
  /** The target's ENCRYPTION_KEY, to re-encrypt them. */
  targetSecret: string;
}

/** A user id from the source system, as it should appear on the target: the owner maps to the new
 * owner; anyone else (who has no account there) becomes null, shown as "Former member". */
function mapUser(id: unknown, o: CopyOptions): string | null {
  if (id === null || id === undefined) return null;
  return id === o.sourceOwnerId ? o.targetOwnerId : null;
}

function reencrypt(value: unknown, o: CopyOptions): string | null {
  if (value === null || value === undefined) return null;
  return encryptTextWithSecret(decryptTextWithSecret(String(value), o.sourceSecret), o.targetSecret);
}

/** Returns the row as it should be written to the target. Never mutates the input. */
export function transformRowForCopy(table: string, row: Row, o: CopyOptions): Row {
  const out: Row = { ...row };
  switch (table) {
    case "weddings":
      out.ownerId = o.targetOwnerId;
      break;
    case "guests":
      out.notes = reencrypt(row.notes, o);
      out.rsvpNotes = reencrypt(row.rsvpNotes, o);
      // RSVP links are made fresh on the target when the planner sends them.
      out.rsvpToken = null;
      out.rsvpTokenHash = null;
      break;
    case "vendors":
      out.shareToken = null;
      out.shareTokenHash = null;
      break;
    case "comments":
      out.authorUserId = mapUser(row.authorUserId, o);
      out.resolvedByUserId = mapUser(row.resolvedByUserId, o);
      break;
    case "change_history_entries":
      out.actorUserId = mapUser(row.actorUserId, o);
      break;
  }
  return out;
}
