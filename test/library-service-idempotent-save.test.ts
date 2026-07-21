// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { outputXtcKey } from "../src/jobs";
import { libraryItemKey } from "../src/library/storage";
import { saveJobToLibrary } from "../src/library/service";

/**
 * Review finding L1 / task item 6: two concurrent
 * POST /api/library/items/from-job requests for the same jobId could both
 * pass the read-then-write idempotency check in saveJobToLibrary and insert
 * duplicate rows. migrations/app/0002_library_job_unique.sql adds
 * `CREATE UNIQUE INDEX idx_library_items_account_job ON
 * library_items(account_id, source_job_id) WHERE source_job_id IS NOT NULL
 * AND deleted_at IS NULL` to make the loser's INSERT fail instead. This test
 * simulates that failure (a real D1 UNIQUE-constraint throw) and asserts
 * saveJobToLibrary's existing "raced" recovery path — re-query
 * findLibraryItemByJobId and return the winner's row instead of erroring —
 * actually fires, and that the loser's R2 copy gets cleaned up rather than
 * left as an orphan object.
 *
 * Fakes scoped to exactly what saveJobToLibrary calls: env.APP_DB (D1) and
 * env.XTC_BUCKET (R2), following the same narrow-fake convention as
 * test/auth-repository-batch.test.ts.
 */

const ACCOUNT_ID = "acct-1";
const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

interface StoredLibraryRow {
  id: string;
  account_id: string;
  source_job_id: string | null;
  source_url: string | null;
  title: string;
  author: string | null;
  r2_key: string;
  size_bytes: number;
  sha256: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

class FakeD1 {
  rows: StoredLibraryRow[] = [];
  // Set to simulate a concurrent request's row landing in the gap between
  // our own idempotency pre-check (findLibraryItemByJobId, which must see
  // no row yet) and our own INSERT — i.e. a genuine race, not something a
  // synchronous read-then-write check could ever observe.
  injectOnNextInsertAttempt: StoredLibraryRow | null = null;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM library_items") && this.sql.includes("source_job_id = ?")) {
      const [accountId, sourceJobId] = this.args as [string, string];
      const row = this.db.rows.find(
        (r) => r.account_id === accountId && r.source_job_id === sourceJobId && r.deleted_at === null,
      );
      return (row ?? null) as T | null;
    }
    if (this.sql.includes("FROM library_items") && this.sql.includes("id = ?")) {
      const [itemId, accountId] = this.args as [string, string];
      const row = this.db.rows.find((r) => r.id === itemId && r.account_id === accountId && r.deleted_at === null);
      return (row ?? null) as T | null;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO library_items")) {
      const [id, accountId, sourceJobId, sourceUrl, title, author, r2Key, sizeBytes, sha256, createdAt] = this
        .args as [string, string, string | null, string | null, string, string | null, string, number, string | null, string];
      if (this.db.injectOnNextInsertAttempt !== null) {
        // The concurrent request's row lands right before ours attempts to
        // commit — this is the interleaving a UNIQUE index (rather than a
        // read-then-write check) is needed to catch.
        this.db.rows.push(this.db.injectOnNextInsertAttempt);
        this.db.injectOnNextInsertAttempt = null;
      }
      const conflict = this.db.rows.some(
        (r) => r.account_id === accountId && r.source_job_id === sourceJobId && sourceJobId !== null && r.deleted_at === null,
      );
      if (conflict) {
        // Simulates the UNIQUE INDEX from migrations/app/0002_library_job_unique.sql.
        throw new Error("UNIQUE constraint failed: library_items.account_id, library_items.source_job_id");
      }
      this.db.rows.push({
        id,
        account_id: accountId,
        source_job_id: sourceJobId,
        source_url: sourceUrl,
        title,
        author,
        r2_key: r2Key,
        size_bytes: sizeBytes,
        sha256,
        created_at: createdAt,
        updated_at: createdAt,
        deleted_at: null,
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

class FakeR2Bucket {
  deletedKeys: string[] = [];
  constructor(private readonly objects: Map<string, { size: number; customMetadata?: Record<string, string> }>) {}

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { body: new ReadableStream(), size: object.size, customMetadata: object.customMetadata };
  }

  async put(): Promise<void> {
    // No-op: saveJobToLibrary only reads back sizeBytes/customMetadata from get(), not put()'s result.
  }

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
  }
}

describe("saveJobToLibrary — idempotent recovery from a UNIQUE(account_id, source_job_id) violation", () => {
  it("returns the winner's row and cleans up the loser's R2 copy instead of throwing", async () => {
    const db = new FakeD1();
    // Simulates a concurrent request that wins the race and inserts its own
    // row for this exact job in the gap between our idempotency pre-check
    // (which must still see nothing) and our own INSERT.
    const winningItemId = "11111111-1111-4111-8111-111111111111";
    db.injectOnNextInsertAttempt = {
      id: winningItemId,
      account_id: ACCOUNT_ID,
      source_job_id: JOB_ID,
      source_url: null,
      title: "Winner Title",
      author: null,
      r2_key: libraryItemKey(ACCOUNT_ID, winningItemId),
      size_bytes: 42,
      sha256: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      deleted_at: null,
    };

    const bucket = new FakeR2Bucket(
      new Map([[outputXtcKey(JOB_ID), { size: 99, customMetadata: { title: "My Book" } }]]),
    );

    const env = { APP_DB: db as unknown as D1Database, XTC_BUCKET: bucket as unknown as R2Bucket };
    const account = { id: ACCOUNT_ID, displayName: "Haruki" };

    const result = await saveJobToLibrary(env, account, { jobId: JOB_ID });

    // Got the *other* request's row back, not a duplicate and not an error.
    expect(result.id).toBe(winningItemId);
    expect(result.title).toBe("Winner Title");
    // Still exactly one row for this job — no duplicate was left behind.
    expect(db.rows.filter((r) => r.source_job_id === JOB_ID)).toHaveLength(1);
    // The R2 object this request itself copied (before losing the DB race)
    // was cleaned up rather than left as an orphan.
    expect(bucket.deletedKeys).toHaveLength(1);
  });
});
