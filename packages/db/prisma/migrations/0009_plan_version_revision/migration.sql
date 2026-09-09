-- FR-7.7 (TS-10, concurrent-edit conflict detection): every write that touches a plan version's
-- seat assignments, status, or label bumps this counter. A client sends back the revision it last
-- saw; if the server's current value has moved on, the write is rejected as stale (with the fresh
-- data attached) instead of silently overwriting whatever changed it -- covering "assignment" and
-- "version" data from FR-7.7's list for the Current Plan Version specifically.

ALTER TABLE "plan_versions" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
