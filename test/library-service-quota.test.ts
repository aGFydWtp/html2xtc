// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { afterEach, describe, expect, it, vi } from "vitest";
import { outputXtcKey } from "../src/jobs";
import { saveJobToLibrary } from "../src/library/service";
import { ApiError } from "../src/security/errors";

/**
 * 登録モード仕様 Phase1 §5.3 / §5.10: ライブラリ保存クォータの境界値テスト
 * (items/bytes)。FakeD1/FakeR2 は test/library-service-idempotent-save.test.ts
 * と同じ narrow-fake 方針 — saveJobToLibrary が発行する SQL 形状だけを扱う。
 */

const ACCOUNT_ID = "acct-1";
const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

interface StoredRow {
  id: string;
  account_id: string;
  source_job_id: string | null;
  size_bytes: number;
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
      const [accountId] = this.args as [string];
      const count = this.db.rows.filter((r) => r.account_id === accountId && r.deleted_at === null).length;
      return { count } as T;
    }
    if (this.sql.includes("SUM(size_bytes)")) {
      const [accountId] = this.args as [string];
      const total = this.db.rows
        .filter((r) => r.account_id === accountId && r.deleted_at === null)
        .reduce((sum, r) => sum + r.size_bytes, 0);
      return { total } as T;
    }
    if (this.sql.includes("source_job_id = ?")) {
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
      const [id, accountId, sourceJobId, , , , , sizeBytes] = this.args as [
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string,
        number,
      ];
      this.db.rows.push({ id, account_id: accountId, source_job_id: sourceJobId, size_bytes: sizeBytes, deleted_at: null });
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

class FakeR2Bucket {
  deletedKeys: string[] = [];
  getCalls = 0;
  constructor(private readonly objects: Map<string, { size: number }>) {}

  async get(key: string) {
    this.getCalls++;
    const object = this.objects.get(key);
    if (!object) return null;
    return { body: new ReadableStream(), size: object.size, customMetadata: undefined };
  }

  async put(): Promise<void> {}

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
  }
}

describe("saveJobToLibrary — item-count quota", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects with 409 before touching R2 when the account is already at the item limit", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "existing-1", account_id: ACCOUNT_ID, source_job_id: "other-job", size_bytes: 10, deleted_at: null });
    const bucket = new FakeR2Bucket(new Map([[outputXtcKey(JOB_ID), { size: 99 }]]));
    const env = { APP_DB: db as unknown as D1Database, XTC_BUCKET: bucket as unknown as R2Bucket, MAX_LIBRARY_ITEMS_PER_ACCOUNT: "1" };

    await expect(saveJobToLibrary(env, { id: ACCOUNT_ID, displayName: "Haruki" }, { jobId: JOB_ID })).rejects.toMatchObject({
      status: 409,
      code: "LIBRARY_ITEM_LIMIT_EXCEEDED",
    });
    expect(bucket.getCalls).toBe(0);
  });

  it("allows the save when one slot under the limit", async () => {
    const db = new FakeD1();
    // No existing rows: itemCount(0) < limit(1).
    const bucket = new FakeR2Bucket(new Map([[outputXtcKey(JOB_ID), { size: 99 }]]));
    const env = {
      APP_DB: db as unknown as D1Database,
      XTC_BUCKET: bucket as unknown as R2Bucket,
      MAX_LIBRARY_ITEMS_PER_ACCOUNT: "1",
      MAX_LIBRARY_BYTES_PER_ACCOUNT: "1000",
    };

    const result = await saveJobToLibrary(env, { id: ACCOUNT_ID, displayName: "Haruki" }, { jobId: JOB_ID });
    expect(result.item.sizeBytes).toBe(99);
    expect(result.created).toBe(true);
    expect(db.rows).toHaveLength(1);
  });
});

describe("saveJobToLibrary — byte-total quota", () => {
  it("rolls back the R2 copy and rejects with 413 when the new total would exceed the byte limit", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "existing-1", account_id: ACCOUNT_ID, source_job_id: "other-job", size_bytes: 950, deleted_at: null });
    const bucket = new FakeR2Bucket(new Map([[outputXtcKey(JOB_ID), { size: 100 }]])); // 950 + 100 > 1000
    const env = {
      APP_DB: db as unknown as D1Database,
      XTC_BUCKET: bucket as unknown as R2Bucket,
      MAX_LIBRARY_ITEMS_PER_ACCOUNT: "100",
      MAX_LIBRARY_BYTES_PER_ACCOUNT: "1000",
    };

    let caught: unknown;
    try {
      await saveJobToLibrary(env, { id: ACCOUNT_ID, displayName: "Haruki" }, { jobId: JOB_ID });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(413);
    expect((caught as ApiError).code).toBe("LIBRARY_STORAGE_LIMIT_EXCEEDED");
    // R2 object was copied then rolled back — not left as an orphan.
    expect(bucket.deletedKeys).toHaveLength(1);
    expect(bucket.deletedKeys[0]).toContain(`library/accounts/${ACCOUNT_ID}/items/`);
    // No D1 row was inserted for the rejected save.
    expect(db.rows).toHaveLength(1);
  });

  it("allows the save exactly at the byte limit (boundary is inclusive)", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "existing-1", account_id: ACCOUNT_ID, source_job_id: "other-job", size_bytes: 900, deleted_at: null });
    const bucket = new FakeR2Bucket(new Map([[outputXtcKey(JOB_ID), { size: 100 }]])); // 900 + 100 == 1000
    const env = {
      APP_DB: db as unknown as D1Database,
      XTC_BUCKET: bucket as unknown as R2Bucket,
      MAX_LIBRARY_ITEMS_PER_ACCOUNT: "100",
      MAX_LIBRARY_BYTES_PER_ACCOUNT: "1000",
    };

    const result = await saveJobToLibrary(env, { id: ACCOUNT_ID, displayName: "Haruki" }, { jobId: JOB_ID });
    expect(result.item.sizeBytes).toBe(100);
    expect(bucket.deletedKeys).toHaveLength(0);
  });
});
