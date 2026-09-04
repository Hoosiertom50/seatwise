"use client";

import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { CommentDTO, GuestDTO, SeatingTableDTO } from "@seatwise/shared";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [targetType, setTargetType] = useState<"GUEST" | "TABLE">("GUEST");
  const [targetId, setTargetId] = useState("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({});
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<{ comments: CommentDTO[] }>(`/api/v1/weddings/${weddingId}/comments`),
      api.get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`),
    ])
      .then(([c, t]) => {
        setComments(c.comments);
        setTables(t.tables);
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

  async function onReply(parentCommentId: string, targetType: "GUEST" | "TABLE", guestId: string | null, tableId: string | null) {
    const text = replyBodies[parentCommentId];
    if (!text?.trim()) return;
    try {
      const { comment } = await api.post<{ comment: CommentDTO }>(
        `/api/v1/weddings/${weddingId}/comments`,
        { targetType, guestId, tableId, body: text, parentCommentId }
      );
      setComments([...comments, comment]);
      setReplyBodies({ ...replyBodies, [parentCommentId]: "" });
      setReplyingTo(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't post that reply.");
    }
  }

  async function onResolve(commentId: string) {
    setComments(
      comments.map((c) => (c.id === commentId ? { ...c, resolvedAt: new Date().toISOString() } : c))
    );
    try {
      await api.post(`/api/v1/weddings/${weddingId}/comments/${commentId}/resolve`);
    } catch {
      setError("Couldn't resolve that comment.");
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading comments...</p>;

  return (
    <div>
      {canComment ? (
        <>
          <h2 className="mb-3 text-lg font-medium">Add a comment</h2>
          <form
            onSubmit={onPost}
            className="mb-8 flex flex-col gap-3 rounded-lg border border-neutral-200 p-4"
          >
            <div className="flex flex-col gap-3 sm:flex-row">
              <select
                aria-label="Comment target type"
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
                value={targetType}
                onChange={(e) => {
                  setTargetType(e.target.value as "GUEST" | "TABLE");
                  setTargetId("");
                }}
              >
                <option value="GUEST">About a guest</option>
                <option value="TABLE">About a table</option>
              </select>
              <select
                aria-label={targetType === "GUEST" ? "Select a guest" : "Select a table"}
                className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                required
              >
                <option value="">
                  {targetType === "GUEST" ? "Select a guest" : "Select a table"}
                </option>
                {targetType === "GUEST"
                  ? guests.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.firstName} {g.lastName}
                      </option>
                    ))
                  : tables.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
              </select>
            </div>
            <textarea
              aria-label="Comment text"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
              rows={2}
              placeholder="What's the question or note?"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
            />
            <button
              type="submit"
              disabled={posting}
              className="self-start rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {posting ? "Posting..." : "Post comment"}
            </button>
          </form>
        </>
      ) : (
        <p className="mb-6 text-sm text-neutral-500">
          You have View-only access — you can read comments here but can&apos;t post one.
        </p>
      )}

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <h2 className="mb-3 text-lg font-medium">Comments ({threads.length})</h2>
      {threads.length === 0 ? (
        <p className="text-sm text-neutral-500">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {threads.map(({ root, replies }) => {
            const canResolve = canComment && (canEdit || root.authorUserId === currentUserId);
            return (
              <li key={root.id} className="rounded-lg border border-neutral-200 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {root.targetLabel}
                      {root.targetRemoved && (
                        <span className="ml-2 text-xs font-normal text-neutral-500">(removed)</span>
                      )}
                    </p>
                    <p className="mt-1 text-sm text-neutral-700">{root.body}</p>
                    <p className="mt-1 text-xs text-neutral-500">
                      {root.authorName} · {new Date(root.createdAt).toLocaleString()}
                    </p>
                  </div>
                  {root.resolvedAt ? (
                    <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                      Resolved
                    </span>
                  ) : (
                    canResolve && (
                      <button
                        onClick={() => onResolve(root.id)}
                        className="shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50"
                      >
                        Resolve
                      </button>
                    )
                  )}
                </div>

                {replies.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-2 border-l-2 border-neutral-100 pl-4">
                    {replies.map((r) => (
                      <li key={r.id}>
                        <p className="text-sm text-neutral-700">{r.body}</p>
                        <p className="mt-0.5 text-xs text-neutral-500">
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
                          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
                          placeholder="Write a reply..."
                          value={replyBodies[root.id] ?? ""}
                          onChange={(e) => setReplyBodies({ ...replyBodies, [root.id]: e.target.value })}
                        />
                        <button
                          onClick={() => onReply(root.id, root.targetType, root.guestId, root.tableId)}
                          className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700"
                        >
                          Reply
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setReplyingTo(root.id)}
                        className="text-sm text-neutral-500 hover:underline"
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
