// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { outputXtcKey } from "../src/jobs";
import { saveJobToLibrary } from "../src/library/service";

/**
 * 登録モード仕様 Phase3 §7: LIBRARY_WRITE_MODE ゲート。
 *   - "read-only" のときだけ新規保存(saveJobToLibrary)を止める（R2にすら
 *     触れずに拒否する — bucket.getCalls で確認）。
 *   - 未設定/不正値/"read-write" は常に許可側（既存動作の非回帰）。
 */

const ACCOUNT_ID = "acct-1";
const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

interface StoredRow {
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
  rows: StoredRow[] = [];

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
    if (this.sql.includes("COUNT(*) AS count")) {
      return { count: 0 } as T;
    }
    if (this.sql.includes("SUM(size_bytes)")) {
      return { total: 0 } as T;
    }
    if (this.sql.includes("source_job_id = ?")) {
      // Idempotency lookup — always "not previously saved" for this test's purposes.
      return null;
    }
    if (this.sql.includes("FROM library_items") && this.sql.includes("WHERE id = ?")) {
      const [itemId, accountId] = this.args as [string, string];
      const row = this.db.rows.find((r) => r.id === itemId && r.account_id === accountId && r.deleted_at === null);
      return (row ?? null) as T | null;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO library_items")) {
      const [id, accountId, sourceJobId, sourceUrl, title, author, r2Key, sizeBytes, sha256, createdAt] = this.args as [
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string,
        number,
        string | null,
        string,
        string,
      ];
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
  getCalls = 0;
  constructor(private readonly objects: Map<string, { size: number }>) {}

  async get(key: string) {
    this.getCalls++;
    const object = this.objects.get(key);
    if (!object) return null;
    return { body: new ReadableStream(), size: object.size, customMetadata: undefined };
  }

  async put(): Promise<void> {}
  async delete(): Promise<void> {}
}

function buildEnv(db: FakeD1, bucket: FakeR2Bucket, extra: Record<string, string> = {}) {
  return {
    APP_DB: db as unknown as D1Database,
    XTC_BUCKET: bucket as unknown as R2Bucket,
    ...extra,
  };
}

describe("saveJobToLibrary — LIBRARY_WRITE_MODE gate", () => {
  it("rejects with 403 LIBRARY_READ_ONLY and never touches R2 when read-only", async () => {
    const db = new FakeD1();
    const bucket = new FakeR2Bucket(new Map([[outputXtcKey(JOB_ID), { size: 99 }]]));
    const env = buildEnv(db, bucket, { LIBRARY_WRITE_MODE: "read-only" });

    await expect(
      saveJobToLibrary(env, { id: ACCOUNT_ID, displayName: "Haruki" }, { jobId: JOB_ID }),
    ).rejects.toMatchObject({ status: 403, code: "LIBRARY_READ_ONLY" });
    expect(bucket.getCalls).toBe(0);
    expect(db.rows).toHaveLength(0);
  });

  it("allows the save when LIBRARY_WRITE_MODE is unset (default read-write — non-regression)", async () => {
    const db = new FakeD1();
    const bucket = new FakeR2Bucket(new Map([[outputXtcKey(JOB_ID), { size: 99 }]]));
    const env = buildEnv(db, bucket);

    const result = await saveJobToLibrary(env, { id: ACCOUNT_ID, displayName: "Haruki" }, { jobId: JOB_ID });
    expect(result.sizeBytes).toBe(99);
  });

  it("allows the save on an unrecognized LIBRARY_WRITE_MODE value (falls back to read-write, never fails closed)", async () => {
    const db = new FakeD1();
    const bucket = new FakeR2Bucket(new Map([[outputXtcKey(JOB_ID), { size: 99 }]]));
    const env = buildEnv(db, bucket, { LIBRARY_WRITE_MODE: "banana" });

    const result = await saveJobToLibrary(env, { id: ACCOUNT_ID, displayName: "Haruki" }, { jobId: JOB_ID });
    expect(result.sizeBytes).toBe(99);
  });

  it("allows the save when explicitly read-write", async () => {
    const db = new FakeD1();
    const bucket = new FakeR2Bucket(new Map([[outputXtcKey(JOB_ID), { size: 99 }]]));
    const env = buildEnv(db, bucket, { LIBRARY_WRITE_MODE: "read-write" });

    const result = await saveJobToLibrary(env, { id: ACCOUNT_ID, displayName: "Haruki" }, { jobId: JOB_ID });
    expect(result.sizeBytes).toBe(99);
  });
});
