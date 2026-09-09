-- FR-7.7 (TS-10, concurrent-edit conflict detection), extended beyond plan versions (see 0009):
-- guests and seating tables get the same optimistic-concurrency revision counter. A client sends
-- back the revision it last saw on every edit; the server rejects a write whose expectedRevision
-- no longer matches instead of silently overwriting whatever changed it in the meantime, and
-- returns the fresh row so the caller can refresh in one round trip.
--
-- Seating rules (guest_relationships) and comments deliberately do NOT get a revision column:
-- neither has an "edit" verb at all (relationships are add/remove only; comments are append-only
-- plus a one-way, idempotent resolve), so there's no in-place write a revision counter would be
-- protecting against. Their conflict surface -- someone deleting/resolving something another user
-- is still looking at -- is instead handled by returning a clear "already gone" signal from the
-- existing not-found path (see relationships.ts / comments.ts) rather than bolting on a counter
-- with nothing to count.

ALTER TABLE "guests" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "seating_tables" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
