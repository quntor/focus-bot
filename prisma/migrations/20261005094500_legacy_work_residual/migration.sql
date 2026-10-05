-- Preserve provable legacy elapsed time without inventing missing physical boundaries.
ALTER TABLE "focus_sessions" ADD COLUMN "legacy_unassigned_seconds" INTEGER NOT NULL DEFAULT 0;
