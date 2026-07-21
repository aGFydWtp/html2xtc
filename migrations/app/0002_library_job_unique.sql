-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 aGFydWtp

-- Enforces the from-job save idempotency that saveJobToLibrary
-- (src/library/service.ts) already assumes: at most one non-deleted
-- library_items row per (account_id, source_job_id). Without this, two
-- concurrent POST /api/library/items/from-job requests for the same jobId
-- (a genuine race, not an attack) could both pass the read-then-write
-- idempotency check and insert duplicate rows + duplicate R2 objects. With
-- this index in place, the loser's INSERT throws a UNIQUE-constraint error,
-- which saveJobToLibrary already catches and turns into "return the other
-- request's row" (see its `raced` recovery path).
CREATE UNIQUE INDEX idx_library_items_account_job
  ON library_items(account_id, source_job_id)
  WHERE source_job_id IS NOT NULL AND deleted_at IS NULL;
