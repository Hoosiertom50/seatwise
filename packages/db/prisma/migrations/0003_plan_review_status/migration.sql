-- TS-9 (Review & Approval, FR-6.4/FR-6.5/FR-6.6): the plan_versions.status column was defined
-- with placeholder values (DRAFT/CURRENT/ARCHIVED) that the app never actually used — every
-- version was always inserted as DRAFT, and "current" was really just "highest versionNumber".
-- Rename the enum values to the real review workflow (Draft / In Review / Approved) that FR-6.4
-- requires, and add "approvedAt" so FR-6.6's "Modified Since Approval" indicator can be derived
-- (a change_history_entries row with createdAt after approvedAt) without a separate boolean flag
-- to keep in sync. Clearing the indicator (moving status away from Approved) is just clearing
-- this column — the change_history_entries rows themselves are never touched, so the historical
-- record survives per FR-6.6.
ALTER TYPE "PlanVersionStatus" RENAME VALUE 'CURRENT' TO 'IN_REVIEW';
ALTER TYPE "PlanVersionStatus" RENAME VALUE 'ARCHIVED' TO 'APPROVED';

ALTER TABLE "plan_versions" ADD COLUMN "approvedAt" TIMESTAMP(3);
