import { randomUUID } from "crypto";
import { pool } from "../pool";
import { notifyWeddingCollaborators } from "./notifications";
import { inWeddingChange, type ActorAccess } from "./wedding-lock";
import { shortenWithEllipsis, timelineTimeLabel } from "@seatwise/shared";

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
  targetType: "GUEST" | "TABLE" | "TIMELINE_ENTRY";
  guestId: string | null;
  tableId: string | null;
  timelineEntryId: string | null;
  targetLabel: string;
  // FR-10.3: the original target no longer exists (removed after this comment was made), but the
  // comment itself — and the label captured at creation — still stands.
  targetRemoved: boolean;
  body: string;
  authorUserId: string | null;
  authorName: string;
  parentCommentId: string | null;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolvedByName: string | null;
  createdAt: Date;
}

export interface CreateCommentInput {
  targetType: "GUEST" | "TABLE" | "TIMELINE_ENTRY";
  guestId?: string | null;
  tableId?: string | null;
  timelineEntryId?: string | null;
  body: string;
  parentCommentId?: string | null;
}

const SELECT_COMMENT = `
  SELECT c.id, c."weddingId", c."targetType", c."guestId", c."tableId", c."timelineEntryId", c."targetLabel",
         (c."guestId" IS NULL AND c."tableId" IS NULL AND c."timelineEntryId" IS NULL) AS "targetRemoved",
         c.body, c."authorUserId", COALESCE(author.name, 'Former member') AS "authorName", c."parentCommentId",
         c."resolvedAt", c."resolvedByUserId", resolver.name AS "resolvedByName", c."createdAt"
  FROM "comments" c
  LEFT JOIN "users" author ON author.id = c."authorUserId"
  LEFT JOIN "users" resolver ON resolver.id = c."resolvedByUserId"
`;

export async function listCommentsForWedding(weddingId: string): Promise<CommentRow[]> {
  const { rows } = await pool.query(
    `${SELECT_COMMENT} WHERE c."weddingId" = $1 ORDER BY c."createdAt" ASC`,
    [weddingId]
  );
  return rows;
}

// TS-195: the CommentError for a comment the database refused because its guest, table, timeline
// entry or thread was removed a moment before it was saved (23503 on that column), or null for
// anything else -- a wedding deleted meanwhile is left to the route ("This wedding was deleted").
function commentTargetGoneError(err: unknown): CommentError | null {
  const e = err as { code?: string; constraint?: string } | null;
  if (e?.code !== "23503") return null;
  const what: Record<string, string> = {
    comments_guestId_fkey: "That guest",
    comments_tableId_fkey: "That table",
    comments_timelineEntryId_fkey: "That timeline entry",
    comments_parentCommentId_fkey: "The comment you replied to",
  };
  const subject = e.constraint ? what[e.constraint] : undefined;
  return subject ? new CommentError(`${subject} was removed a moment ago, so your comment wasn't saved.`, "NOT_FOUND") : null;
}

export async function createComment(
  weddingId: string,
  authorUserId: string,
  input: CreateCommentInput,
  /** TS-204: the access the request was let in with -- read again as the comment is saved. */
  actor?: ActorAccess
): Promise<CommentRow> {
  let targetLabel: string;
  let guestId: string | null = null;
  let tableId: string | null = null;
  let timelineEntryId: string | null = null;

  // TS-180: a reply goes on a comment that starts a thread (threads are one level deep), and is
  // about whatever that comment is about -- the target is taken from it, not from the request, so a
  // reply can't land in a thread while pointing at a different guest or table.
  let parentAuthorId: string | null = null;
  if (input.parentCommentId) {
    const { rows } = await pool.query<{
      authorUserId: string;
      parentCommentId: string | null;
      targetType: CreateCommentInput["targetType"];
      guestId: string | null;
      tableId: string | null;
      timelineEntryId: string | null;
    }>(
      `SELECT "authorUserId", "parentCommentId", "targetType", "guestId", "tableId", "timelineEntryId"
       FROM "comments" WHERE id = $1 AND "weddingId" = $2`,
      [input.parentCommentId, weddingId]
    );
    const parent = rows[0];
    if (!parent) throw new CommentError("Parent comment not found.", "NOT_FOUND");
    if (parent.parentCommentId) {
      throw new CommentError("Reply to the comment that starts the thread, not to a reply.", "INVALID_TARGET");
    }
    // TS-190: the thread's guest, table or timeline entry was removed since -- a reply would have
    // nothing to be about (it used to fail with "guestId is required").
    if (!parent.guestId && !parent.tableId && !parent.timelineEntryId) {
      const what = parent.targetType === "GUEST" ? "guest" : parent.targetType === "TABLE" ? "table" : "timeline entry";
      throw new CommentError(`That comment's ${what} was removed, so it can't take replies.`, "INVALID_TARGET");
    }
    parentAuthorId = parent.authorUserId;
    input = {
      ...input,
      targetType: parent.targetType,
      guestId: parent.guestId,
      tableId: parent.tableId,
      timelineEntryId: parent.timelineEntryId,
    };
  }

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
  } else if (input.targetType === "TABLE") {
    if (!input.tableId) throw new CommentError("tableId is required for a table comment.", "INVALID_TARGET");
    const { rows } = await pool.query(
      `SELECT label FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2`,
      [input.tableId, weddingId]
    );
    const table = rows[0];
    if (!table) throw new CommentError("Table not found.", "NOT_FOUND");
    tableId = input.tableId;
    targetLabel = `Table: ${table.label}`;
  } else {
    if (!input.timelineEntryId)
      throw new CommentError("timelineEntryId is required for a timeline comment.", "INVALID_TARGET");
    const { rows } = await pool.query(
      `SELECT time, "nextDay", description FROM "timeline_entries" WHERE id = $1 AND "weddingId" = $2`,
      [input.timelineEntryId, weddingId]
    );
    const entry = rows[0];
    if (!entry) throw new CommentError("Timeline entry not found.", "NOT_FOUND");
    timelineEntryId = input.timelineEntryId;
    // TS-180: the time as the app shows it (4:30 PM), not the stored 24-hour "16:30".
    // TS-214: with "(next day)" for an entry after midnight.
    targetLabel = `Timeline: ${timelineTimeLabel(entry.time, entry.nextDay)} ${entry.description}`;
  }

  const id = randomUUID();
  let created: CommentRow;
  try {
    // TS-204: saved with the person's access read again in the same transaction (see inWeddingChange).
    // TS-209: the saved comment comes back from the insert itself -- it used to be read again at the
    // end, and a failure there answered an error for a comment that was saved.
    const { rows: inserted } = await inWeddingChange(weddingId, actor, (client) =>
      client.query<CommentRow>(
        `INSERT INTO "comments" (id, "weddingId", "targetType", "guestId", "tableId", "timelineEntryId", "targetLabel", body, "authorUserId", "parentCommentId")
       VALUES ($1, $2, $3::"CommentTargetType", $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, "weddingId", "targetType", "guestId", "tableId", "timelineEntryId", "targetLabel",
         false AS "targetRemoved", body, "authorUserId",
         COALESCE((SELECT name FROM "users" WHERE id = $9), 'Former member') AS "authorName", "parentCommentId",
         "resolvedAt", "resolvedByUserId", NULL::text AS "resolvedByName", "createdAt"`,
        [
        id,
        weddingId,
        input.targetType,
        guestId,
        tableId,
        timelineEntryId,
        targetLabel,
        input.body,
        authorUserId,
        input.parentCommentId ?? null,
        ]
      )
    );
    created = inserted[0];
  } catch (err) {
    // TS-195: what the comment is about was removed between the check above and saving it -- the
    // database refused the comment (nothing saved). Said in words, not a server error.
    throw commentTargetGoneError(err) ?? err;
  }

  if (input.parentCommentId) {
    // FR-10.2: a reply notifies everyone (owner + collaborators) except whoever wrote it —
    // including the original commenter, who is just another recipient of the general fan-out.
    void parentAuthorId; // kept for clarity of intent; notifyWeddingCollaborators already excludes the actor
    // TS-194: the change above is already saved -- telling people about it is best effort, so a
    // failure is logged and never turns the saved change into an error.
    try {
      await notifyWeddingCollaborators(
        weddingId,
        authorUserId,
        "COMMENT_REPLY",
        // TS-214: cut between whole characters, with "…" -- slice could split an emoji in half.
        `New reply on "${targetLabel}": ${shortenWithEllipsis(input.body, 120)}`,
        // TS-168: the email doesn't carry the comment itself (text anyone with Comment access typed,
        // arriving as if from Seatwise) -- it points to the app, where the reply is shown.
        { emailMessage: `There's a new reply on "${targetLabel}" — open Seatwise to read it.` }
      );
    } catch (err) {
      console.error("Saved, but notifying the wedding's members failed:", err);
    }
  } else {
    // TS-213 (Tom's decision): a new comment thread notifies everyone else too (in the app, and by
    // email unless they've turned emails off) -- before, only replies did, so a question asked in a
    // new thread could go unseen.
    try {
      await notifyWeddingCollaborators(
        weddingId,
        authorUserId,
        "COMMENT_ADDED",
        `New comment on "${targetLabel}": ${input.body.slice(0, 120)}`,
        // TS-168: as for replies, the email points to the app rather than carrying the comment.
        { emailMessage: `There's a new comment on "${targetLabel}" — open Seatwise to read it.` }
      );
    } catch (err) {
      console.error("Saved, but notifying the wedding's members failed:", err);
    }
  }

  return created;
}

// FR-10.3: only the original commenter or someone with Edit access may resolve a thread. Returns
// the updated comment (rather than void) so the caller can sync its local state -- including
// resolvedByName, which the client has no other way to know -- instead of guessing at the result.
export async function resolveComment(
  weddingId: string,
  commentId: string,
  requesterId: string,
  requesterCanEdit: boolean,
  /** TS-204: the access the request was let in with -- read again as the thread is resolved. */
  actor?: ActorAccess
): Promise<CommentRow> {
  const { rows } = await pool.query(
    `SELECT "authorUserId" FROM "comments" WHERE id = $1 AND "weddingId" = $2`,
    [commentId, weddingId]
  );
  const comment = rows[0];
  if (!comment) throw new CommentError("Comment not found.", "NOT_FOUND");
  if (comment.authorUserId !== requesterId && !requesterCanEdit) {
    throw new CommentError("Only the original commenter or an editor can resolve this comment.", "FORBIDDEN");
  }
  await inWeddingChange(weddingId, actor, (client) =>
    client.query(`UPDATE "comments" SET "resolvedAt" = now(), "resolvedByUserId" = $1 WHERE id = $2`, [requesterId, commentId])
  );

  const { rows: updatedRows } = await pool.query(`${SELECT_COMMENT} WHERE c.id = $1`, [commentId]);
  return updatedRows[0];
}
