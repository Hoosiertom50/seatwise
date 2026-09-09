-- TS-10 (Manual Adjustment, FR-7.4): let a guest or table be locked so future automated
-- generation leaves them alone. Locks never affect hard-rule checks or manual moves — they're
-- read by the seating engine only, at generation time.
ALTER TABLE "guests" ADD COLUMN "isLocked" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "seating_tables" ADD COLUMN "isLocked" BOOLEAN NOT NULL DEFAULT FALSE;
