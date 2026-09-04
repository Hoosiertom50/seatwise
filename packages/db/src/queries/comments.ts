import { randomUUID } from "crypto";
import { pool } from "../pool";
import { notifyWeddingCollaborators } from "./notifications";

export class CommentError extends Error {
  constructor(
    message: string,
    public code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_TARGET"
  ) {
    super(message);
    this.name = "CommentError";
  }
}

export interface CommentRow {
  id: string;
  weddingId: string;
  targetType: "GUEST" | "TABLE";
  guestId: string | null;
  tableId: string | null;
  targetLabel: string;
  // FR-10.3: the original target no longer exists (removed after this comment was made), but the
  // comment itself — and the label captured at creation — still stands.
  targetRemoved: boolean;
  body: string;
  authorUserId: string;
  authorName: string;
  parentCommentId: string | null;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolvedByName: string | null;
  createdAt: Date;
}

export interface CreateCommentInput {
  targetType: "GUEST" | "TABLE";
  guestId?: string | null;
  tableId?: string | null;
  body: string;
  parentCommentId?: string | null;
}

export async function listCommentsForWedding(weddingId: string): Promise<CommentRow[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c."weddingId", c."targetType", c."guestId", c."tableId", c."targetLabel",
            (c."guestId" IS NULL AND c."tableId" IS NULL) AS "targetRemoved",
            c.body, c."authorUserId", author.name AS "authorName", c."parentCommentId",
            c."resolvedAt", c."resolvedByUserId", resolver.name AS "resolvedByName", c."createdAt"
     FROM "comments" c
     JOIN "users" author ON author.id = c."authorUserId"
     LEFT JOIN "users" resolver ON resolver.id = c."resolvedByUserId"
     WHERE c."weddingId" = $1
     ORDER BY c."createdAt" ASC`,
    [weddingId]
  );
  return rows;
}

export async function createComment(
  weddingId: string,
  authorUserId: string,
  input: CreateCommentInput
): Promise<CommentRow> {
  let targetLabel: string;
  let guestId: string | null = null;
  let tableId: string | null = null;

  if (input.targetType === "GUEST") {
    if (!input.guestId) throw new CommentError("guestId is required for a guest comment.", "INVALID_TARGET");
    const { rows } = await pool.query(
      `SELECT "firstName", "lastName" FROM "guests" WHERE id = $1 AND "weddingId" = $2`,
      [input.guestId, weddingId]
    );
    const guest = rows[0];
    if (!guest) throw new CommentError("Guest not found.", "NOT_FOUND");
    guestId = input.guestId;
    targetLabel = `Guest: ${guest.firstName} ${guest.lastName}`;
  } else {
    if (!input.tableId) throw new CommentError("tableId is required for a table comment.", "INVALID_TARGET");
    const { rows } = await pool.query(
      `SELECT label FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2`,
      [input.tableId, weddingId]
    );
    const table = rows[0];
    if (!table) throw new CommentError("Table not found.", "NOT_FOUND");
    tableId = input.tableId;
    targetLabel = `Table: ${table.label}`;
  }

  let parentAuthorId: string | null = null;
  if (input.parentCommentId) {
    const { rows } = await pool.query(
      `SELECT "authorUserId" FROM "comments" WHERE id = $1 AND "weddingId" = $2`,
      [input.parentCommentId, weddingId]
    );
    const parent = rows[0];
    if (!parent) throw new CommentError("Parent comment not found.", "NOT_FOUND");
    parentAuthorId = parent.authorUserId;
  }

  const id = randomUUID();
  await pool.query(
    `INSERT INTO "comments" (id, "weddingId", "targetType", "guestId", "tableId", "targetLabel", body, "authorUserId", "parentCommentId")
     VALUES ($1, $2, $3::"CommentTargetType", $4, $5, $6, $7, $8, $9)`,
    [id, weddingId, input.targetType, guestId, tableId, targetLabel, input.body, authorUserId, input.parentCommentId ?? null]
  );

  if (input.parentCommentId) {
    // FR-10.2: a reply notifies everyone (owner + collaborators) except whoever wrote it —
    // including the original commenter, who is just another recipient of the general fan-out.
    void parentAuthorId; // kept for clarity of intent; notifyWeddingCollaborators already excludes the actor
    await notifyWeddingCollaborators(
      weddingId,
      authorUserId,
      "COMMENT_REPLY",
      `New reply on "${targetLabel}": ${input.body.slice(0, 120)}`
    );
  }

  const { rows } = await pool.query(
    `SELECT c.id, c."weddingId", c."targetType", c."guestId", c."tableId", c."targetLabel",
            (c."guestId" IS NULL AND c."tableId" IS NULL) AS "targetRemoved",
            c.body, c."authorUserId", author.name AS "authorName", c."parentCommentId",
            c."resolvedAt", c."resolvedByUserId", resolver.name AS "resolvedByName", c."createdAt"
     FROM "comments" c
     JOIN "users" author ON author.id = c."authorUserId"
     LEFT JOIN "users" resolver ON resolver.id = c."resolvedByUserId"
     WHERE c.id = $1`,
    [id]
  );
  return rows[0];
}

// FR-10.3: only the original commenter or someone with Edit access may resolve a thread.
export async function resolveComment(
  weddingId: string,
  commentId: string,
  requesterId: string,
  requesterCanEdit: boolean
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT "authorUserId" FROM "comments" WHERE id = $1 AND "weddingId" = $2`,
    [commentId, weddingId]
  );
  const comment = rows[0];
  if (!comment) throw new CommentError("Comment not found.", "NOT_FOUND");
  if (comment.authorUserId !== requesterId && !requesterCanEdit) {
    throw new CommentError("Only the original commenter or an editor can resolve this comment.", "FORBIDDEN");
  }
  await pool.query(
    `UPDATE "comments" SET "resolvedAt" = now(), "resolvedByUserId" = $1 WHERE id = $2`,
    [requesterId, commentId]
  );
}
