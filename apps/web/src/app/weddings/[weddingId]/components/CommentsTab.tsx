"use client";

import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { CommentDTO, GuestDTO, SeatingTableDTO, TimelineEntryDTO } from "@seatwise/shared";

// TS-13 (Collaboration & Notifications, FR-10.3): comments attached to a guest or table. A
// dedicated tab (rather than inline per-row) keeps this tractable — pick a target, see its
// thread, reply, resolve. A comment survives its target being later renamed or removed: it keeps
// the label captured when it was written.
export function CommentsTab({
  weddingId,
  guests,
  canComment,
  canEdit,
  currentUserId,
}: {
  weddingId: string;
  guests: GuestDTO[];
  canComment: boolean;
  canEdit: boolean;
  currentUserId: string | null;
}) {
  const [comments, setComments] = useState<CommentDTO[]>([]);
  const [tables, setTables] = useState<SeatingTableDTO[]>([]);
  // TS-18 (FR-13.3): a comment can also target a single timeline entry.
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [targetType, setTargetType] = useState<"GUEST" | "TABLE" | "TIMELINE_ENTRY">("GUEST");
  const [targetId, setTargetId] = useState("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({});
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<{ comments: CommentDTO[] }>(`/api/v1/weddings/${weddingId}/comments`),
      api.get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`),
      api.get<{ entries: TimelineEntryDTO[] }>(`/api/v1/weddings/${weddingId}/timeline-entries`),
    ])
      .then(([c, t, tl]) => {
        setComments(c.comments);
        setTables(t.tables);
        setTimelineEntries(tl.entries);
      })
      .catch(() => setError("Couldn't load comments."))
      .finally(() => setLoading(false));
  }, [weddingId]);

  // Top-level comments (no parent), each with its replies attached, newest top-level first.
  const threads = useMemo(() => {
    const byParent = new Map<string, CommentDTO[]>();
    for (const c of comments) {
      if (c.parentCommentId) {
        if (!byParent.has(c.parentCommentId)) byParent.set(c.parentCommentId, []);
        byParent.get(c.parentCommentId)!.push(c);
      }
    }
    return comments
      .filter((c) => !c.parentCommentId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((c) => ({ root: c, replies: (byParent.get(c.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }));
  }, [comments]);

  async function onPost(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!targetId) {
      setError("Pick who or what this comment is about.");
      return;
    }
    setPosting(true);
    try {
      const { comment } = await api.post<{ comment: CommentDTO }>(
        `/api/v1/weddings/${weddingId}/comments`,
        {
          targetType,
          guestId: targetType === "GUEST" ? targetId : undefined,
          tableId: targetType === "TABLE" ? targetId : undefined,
          timelineEntryId: targetType === "TIMELINE_ENTRY" ? targetId : undefined,
          body,
        }
      );
      setComments([comment, ...comments]);
      setBody("");
      setTargetId("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't post that comment.");
    } finally {
      setPosting(false);
    }
  }

  async function onReply(
    parentCommentId: string,
    targetType: "GUEST" | "TABLE" | "TIMELINE_ENTRY",
    guestId: string | null,
    tableId: string | null,
    timelineEntryId: string | null
  ) {
    const text = replyBodies[parentCommentId];
    if (!text?.trim()) return;
    try {
      const { comment } = await api.post<{ comment: CommentDTO }>(
        `/api/v1/weddings/${weddingId}/comments`,
        { targetType, guestId, tableId, timelineEntryId, body: text, parentCommentId }
      );
      setComments([...comments, comment]);
      setReplyBodies({ ...replyBodies, [parentCommentId]: "" });
      setReplyingTo(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't post that reply.");
    }
  }

  // Comments have no delete, so resolve's own "not found" case can only really mean a bad id --
  // there's no other-user action that can pull the row out from under this one the way a delete
  // could. Still, sync from the server's returned comment rather than guessing at
  // resolvedAt/resolvedByName, and revert the optimistic update on any failure (a gap the
  // optimistic update here previously left open).
  async function onResolve(commentId: string) {
    const prev = comments;
    setComments(
      comments.map((c) => (c.id === commentId ? { ...c, resolvedAt: new Date().toISOString() } : c))
    );
    try {
      const { comment } = await api.post<{ comment: CommentDTO }>(
        `/api/v1/weddings/${weddingId}/comments/${commentId}/resolve`
      );
      setComments(prev.map((c) => (c.id === commentId ? comment : c)));
    } catch (err) {
      setComments(prev);
      setError(err instanceof ApiError ? err.message : "Couldn't resolve that comment.");
    }
  }

  if (loading) return <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading comments...</p>;

  return (
    <div>
      {canComment ? (
        <>
          <h2 className="mb-3 text-lg font-medium">Add a comment</h2>
          <form
            onSubmit={onPost}
            className="mb-8 flex flex-col gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4"
          >
            <div className="flex flex-col gap-3 sm:flex-row">
              <select
                aria-label="Comment target type"
                className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={targetType}
                onChange={(e) => {
                  setTargetType(e.target.value as "GUEST" | "TABLE" | "TIMELINE_ENTRY");
                  setTargetId("");
                }}
              >
                <option value="GUEST">About a guest</option>
                <option value="TABLE">About a table</option>
                <option value="TIMELINE_ENTRY">About a timeline entry</option>
              </select>
              <select
                aria-label={
                  targetType === "GUEST"
                    ? "Select a guest"
                    : targetType === "TABLE"
                      ? "Select a table"
                      : "Select a timeline entry"
                }
                className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                required
              >
                <option value="">
                  {targetType === "GUEST"
                    ? "Select a guest"
                    : targetType === "TABLE"
                      ? "Select a table"
                      : "Select a timeline entry"}
                </option>
                {targetType === "GUEST" &&
                  guests.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.firstName} {g.lastName}
                    </option>
                  ))}
                {targetType === "TABLE" &&
                  tables.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                {targetType === "TIMELINE_ENTRY" &&
                  timelineEntries.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.time} — {e.description}
                    </option>
                  ))}
              </select>
            </div>
            <textarea
              aria-label="Comment text"
              className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              rows={2}
              placeholder="What's the question or note?"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
            />
            <button
              type="submit"
              disabled={posting}
              className="self-start rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 dark:hover:bg-neutral-300 disabled:opacity-50"
            >
              {posting ? "Posting..." : "Post comment"}
            </button>
          </form>
        </>
      ) : (
        <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">
          You have View-only access — you can read comments here but can&apos;t post one.
        </p>
      )}

      {error && <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <h2 className="mb-3 text-lg font-medium">Comments ({threads.length})</h2>
      {threads.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {threads.map(({ root, replies }) => {
            const canResolve = canComment && (canEdit || root.authorUserId === currentUserId);
            return (
              <li key={root.id} className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {root.targetLabel}
                      {root.targetRemoved && (
                        <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">(removed)</span>
                      )}
                    </p>
                    <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">{root.body}</p>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      {root.authorName} · {new Date(root.createdAt).toLocaleString()}
                    </p>
                  </div>
                  {root.resolvedAt ? (
                    <span className="shrink-0 rounded-full bg-green-100 dark:bg-green-900 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                      Resolved
                    </span>
                  ) : (
                    canResolve && (
                      <button
                        onClick={() => onResolve(root.id)}
                        className="shrink-0 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800 dark:hover:bg-neutral-800"
                      >
                        Resolve
                      </button>
                    )
                  )}
                </div>

                {replies.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-2 border-l-2 border-neutral-100 dark:border-neutral-800 pl-4">
                    {replies.map((r) => (
                      <li key={r.id}>
                        <p className="text-sm text-neutral-700 dark:text-neutral-300">{r.body}</p>
                        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                          {r.authorName} · {new Date(r.createdAt).toLocaleString()}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}

                {canComment && !root.targetRemoved && (
                  <div className="mt-3">
                    {replyingTo === root.id ? (
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                          aria-label="Reply text"
                          className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                          placeholder="Write a reply..."
                          value={replyBodies[root.id] ?? ""}
                          onChange={(e) => setReplyBodies({ ...replyBodies, [root.id]: e.target.value })}
                        />
                        <button
                          onClick={() =>
                            onReply(root.id, root.targetType, root.guestId, root.tableId, root.timelineEntryId)
                          }
                          className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-3 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 dark:hover:bg-neutral-300"
                        >
                          Reply
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setReplyingTo(root.id)}
                        className="text-sm text-neutral-500 dark:text-neutral-400 hover:underline"
                      >
                        Reply
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
