"use client";

import { formatClockTime, formatDateTime } from "@/lib/display-format";
import { useEffect, useMemo, useState, useRef } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { CommentDTO, GuestDTO, SeatingTableDTO, TimelineEntryDTO } from "@seatwise/shared";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

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
  // TS-151: which reply is being posted, so a double-click can't post it twice.
  const [postingReply, setPostingReply] = useState<string | null>(null);
  // TS-199: the reply box whose Reply was pressed with nothing (or only spaces) in it.
  const [replyEmpty, setReplyEmpty] = useState<string | null>(null);
  // TS-159: tell the page this tab has input that leaving it would lose.
  // TS-182: only while the comment boxes are there (they're hidden without Comment access).
  // TS-191: only the reply box that's open counts. A draft left in a closed one is kept (it's back
  // when Reply is opened again) but can't be seen, and asking about it puzzled people.
  const openReplyDraft = replyingTo ? (replyBodies[replyingTo] ?? "") : "";
  useUnsavedChanges("comments", canComment && !!(body.trim() || openReplyDraft.trim()));
  // Checked synchronously: a second click can land before React re-renders with postingReply set.
  const postingReplyNow = useRef(false);
  // TS-191: comments whose Resolve is on its way, so a second press doesn't send it again.
  const [resolving, setResolving] = useState<ReadonlySet<string>>(() => new Set());
  const resolvingNow = useRef(new Set<string>());

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
      setComments((cur) => [comment, ...cur]);
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
    if (!text?.trim() || postingReplyNow.current) return;
    postingReplyNow.current = true;
    setPostingReply(parentCommentId);
    try {
      const { comment } = await api.post<{ comment: CommentDTO }>(
        `/api/v1/weddings/${weddingId}/comments`,
        { targetType, guestId, tableId, timelineEntryId, body: text, parentCommentId }
      );
      setComments((cur) => [...cur, comment]);
      setReplyBodies((cur) => ({ ...cur, [parentCommentId]: "" }));
      setReplyingTo(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't post that reply.");
    } finally {
      postingReplyNow.current = false;
      setPostingReply(null);
    }
  }

  // Comments have no delete, so resolve's own "not found" case can only really mean a bad id --
  // there's no other-user action that can pull the row out from under this one the way a delete
  // could. Still, sync from the server's returned comment rather than guessing at
  // resolvedAt/resolvedByName, and revert the optimistic update on any failure (a gap the
  // optimistic update here previously left open).
  // TS-175: every update works on the list as it is at that moment. It used to put back a copy
  // taken when Resolve was clicked, so a reply posted while the resolve was saving disappeared.
  async function onResolve(commentId: string) {
    if (resolvingNow.current.has(commentId)) return;
    resolvingNow.current.add(commentId);
    setResolving((cur) => new Set(cur).add(commentId));
    try {
      await resolveComment(commentId);
    } finally {
      resolvingNow.current.delete(commentId);
      setResolving((cur) => {
        const next = new Set(cur);
        next.delete(commentId);
        return next;
      });
    }
  }

  async function resolveComment(commentId: string) {
    const before = comments.find((c) => c.id === commentId);
    setComments((cur) => cur.map((c) => (c.id === commentId ? { ...c, resolvedAt: new Date().toISOString() } : c)));
    try {
      const { comment } = await api.post<{ comment: CommentDTO }>(
        `/api/v1/weddings/${weddingId}/comments/${commentId}/resolve`
      );
      setComments((cur) => cur.map((c) => (c.id === commentId ? comment : c)));
    } catch (err) {
      if (before) setComments((cur) => cur.map((c) => (c.id === commentId ? before : c)));
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
                      {formatClockTime(e.time)} — {e.description}
                    </option>
                  ))}
              </select>
            </div>
            <textarea
              maxLength={FIELD_LIMITS.comment}
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
              className="self-start rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
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

      {error && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

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
                  {/* TS-191: long unbroken text wraps instead of running off a phone screen. */}
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">
                      {root.targetLabel}
                      {root.targetRemoved && (
                        <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">(removed)</span>
                      )}
                    </p>
                    <p className="mt-1 whitespace-pre-line break-words text-sm text-neutral-700 dark:text-neutral-300 [overflow-wrap:anywhere]">{root.body}</p>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      {root.authorName} · {formatDateTime(root.createdAt)}
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
                        disabled={resolving.has(root.id)}
                        className="shrink-0 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                      >
                        {resolving.has(root.id) ? "Resolving…" : "Resolve"}
                      </button>
                    )
                  )}
                </div>

                {replies.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-2 border-l-2 border-neutral-100 dark:border-neutral-800 pl-4">
                    {replies.map((r) => (
                      <li key={r.id} className="min-w-0">
                        <p className="whitespace-pre-line break-words text-sm text-neutral-700 dark:text-neutral-300 [overflow-wrap:anywhere]">{r.body}</p>
                        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                          {r.authorName} · {formatDateTime(r.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}

                {canComment && !root.targetRemoved && (
                  <div className="mt-3">
                    {replyingTo === root.id ? (
                      // TS-199: a form, so Enter in the box sends the reply like the button does;
                      // Cancel closes it (the draft is kept for next time).
                      <form
                        className="flex flex-col gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!(replyBodies[root.id] ?? "").trim()) {
                            setReplyEmpty(root.id);
                            return;
                          }
                          setReplyEmpty(null);
                          void onReply(root.id, root.targetType, root.guestId, root.tableId, root.timelineEntryId);
                        }}
                      >
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                          // TS-191: opening Reply puts focus in the box.
                          autoFocus
                          maxLength={FIELD_LIMITS.comment}
                          aria-label="Reply text"
                          className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                          placeholder="Write a reply..."
                          value={replyBodies[root.id] ?? ""}
                          onChange={(e) => {
                            setReplyBodies({ ...replyBodies, [root.id]: e.target.value });
                            if (replyEmpty === root.id && e.target.value.trim()) setReplyEmpty(null);
                          }}
                          aria-describedby={replyEmpty === root.id ? `reply-empty-${root.id}` : undefined}
                        />
                        <button
                          type="submit"
                          disabled={postingReply === root.id}
                          className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-3 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
                        >
                          {postingReply === root.id ? "Posting..." : "Reply"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setReplyingTo(null);
                            setReplyEmpty(null);
                            // Back to the Reply button that opened the box.
                            setTimeout(() => document.getElementById(`reply-open-${root.id}`)?.focus(), 0);
                          }}
                          disabled={postingReply === root.id}
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                      {replyEmpty === root.id && (
                        <p id={`reply-empty-${root.id}`} role="alert" className="text-sm text-red-600 dark:text-red-400">
                          Write something first.
                        </p>
                      )}
                      </form>
                    ) : (
                      <button
                        id={`reply-open-${root.id}`}
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
