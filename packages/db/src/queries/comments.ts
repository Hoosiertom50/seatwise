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

// TS-180: "16:30" as "4:30 PM" -- the same as the web app's formatClockTime (lib/display-format).
function clockTime12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return hhmm;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

export async function createComment(
  weddingId: string,
  authorUserId: string,
  input: CreateCommentInput
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
      `SELECT time, description FROM "timeline_entries" WHERE id = $1 AND "weddingId" = $2`,
      [input.timelineEntryId, weddingId]
    );
    const entry = rows[0];
    if (!entry) throw new CommentError("Timeline entry not found.", "NOT_FOUND");
    timelineEntryId = input.timelineEntryId;
    // TS-180: the time as the app shows it (4:30 PM), not the stored 24-hour "16:30".
    targetLabel = `Timeline: ${clockTime12(entry.time)} ${entry.description}`;
  }

  const id = randomUUID();
  await pool.query(
    `INSERT INTO "comments" (id, "weddingId", "targetType", "guestId", "tableId", "timelineEntryId", "targetLabel", body, "authorUserId", "parentCommentId")
     VALUES ($1, $2, $3::"CommentTargetType", $4, $5, $6, $7, $8, $9, $10)`,
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
  );

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
        `New reply on "${targetLabel}": ${input.body.slice(0, 120)}`,
        // TS-168: the email doesn't carry the comment itself (text anyone with Comment access typed,
        // arriving as if from Seatwise) -- it points to the app, where the reply is shown.
        { emailMessage: `There's a new reply on "${targetLabel}" — open Seatwise to read it.` }
      );
    } catch (err) {
      console.error("Saved, but notifying the wedding's members failed:", err);
    }
  }

  const { rows } = await pool.query(`${SELECT_COMMENT} WHERE c.id = $1`, [id]);
  return rows[0];
}

// FR-10.3: only the original commenter or someone with Edit access may resolve a thread. Returns
// the updated comment (rather than void) so the caller can sync its local state -- including
// resolvedByName, which the client has no other way to know -- instead of guessing at the result.
export async function resolveComment(
  weddingId: string,
  commentId: string,
  requesterId: string,
  requesterCanEdit: boolean
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
  await pool.query(
    `UPDATE "comments" SET "resolvedAt" = now(), "resolvedByUserId" = $1 WHERE id = $2`,
    [requesterId, commentId]
  );

  const { rows: updatedRows } = await pool.query(`${SELECT_COMMENT} WHERE c.id = $1`, [commentId]);
  return updatedRows[0];
}
