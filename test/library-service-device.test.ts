// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { outputXtcKey } from "../src/jobs";
import { saveJobToLibrary } from "../src/library/service";
import type { Account } from "../src/auth/sessions";

/**
 * migrations/app/0005_library_item_device.sql adds device/width/height to
 * library_items, recorded from the R2 customMetadata storeXtcOutput
 * (src/pipeline.ts) writes onto every jobs/{jobId}/output.xtc. This file
 * exercises saveJobToLibrary end to end (its own narrow FakeD1/FakeR2Bucket,
 * mirroring test/library-service-idempotent-save.test.ts's convention) to
 * confirm those three columns are actually populated from the source
 * object's metadata — not silently left at the schema's X3 defaults.
 */

const ACCOUNT_ID = "acct-1";
const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";
const ACCOUNT: Account = { id: ACCOUNT_ID, displayName: "Test" };

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
  device: string;
  width: number;
  height: number;
}

class FakeD1 {
  rows: StoredLibraryRow[] = [];
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
    if (this.sql.includes("COUNT(*)")) {
      return { count: this.db.rows.length } as T;
    }
    if (this.sql.includes("SUM(size_bytes)")) {
      return { total: this.db.rows.reduce((sum, r) => sum + r.size_bytes, 0) } as T;
    }
    if (this.sql.includes("source_job_id = ?")) {
      const [accountId, sourceJobId] = this.args as [string, string];
      const row = this.db.rows.find(
        (r) => r.account_id === accountId && r.source_job_id === sourceJobId && r.deleted_at === null,
      );
      return (row ?? null) as T | null;
    }
    if (this.sql.includes("WHERE id = ? AND account_id = ?")) {
      const [itemId, accountId] = this.args as [string, string];
      const row = this.db.rows.find((r) => r.id === itemId && r.account_id === accountId && r.deleted_at === null);
      return (row ?? null) as T | null;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO library_items")) {
      const [
        id,
        accountId,
        sourceJobId,
        sourceUrl,
        title,
        author,
        r2Key,
        sizeBytes,
        sha256,
        createdAt,
        updatedAt,
        device,
        width,
        height,
      ] = this.args as [
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
        string,
        number,
        number,
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
        updated_at: updatedAt,
        deleted_at: null,
        device,
        width,
        height,
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

class FakeR2Bucket {
  constructor(private readonly objects: Map<string, { size: number; customMetadata?: Record<string, string> }>) {}

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { body: new ReadableStream(), size: object.size, customMetadata: object.customMetadata };
  }

  async put(): Promise<void> {}
  async delete(): Promise<void> {}
}

function fakeEnv(bucket: FakeR2Bucket, db: FakeD1) {
  return {
    APP_DB: db as unknown,
    XTC_BUCKET: bucket as unknown,
  } as Parameters<typeof saveJobToLibrary>[0];
}

describe("saveJobToLibrary — device/width/height recording", () => {
  it("records device='x4', width=480, height=800 for a job converted for X4", async () => {
    const db = new FakeD1();
    const bucket = new FakeR2Bucket(
      new Map([
        [
          outputXtcKey(JOB_ID),
          { size: 1234, customMetadata: { title: "Book", device: "x4", width: "480", height: "800" } },
        ],
      ]),
    );

    const result = await saveJobToLibrary(fakeEnv(bucket, db), ACCOUNT, { jobId: JOB_ID });

    expect(result.item.device).toBe("x4");
    expect(result.item.width).toBe(480);
    expect(result.item.height).toBe(800);
    expect(db.rows[0]?.device).toBe("x4");
    expect(db.rows[0]?.width).toBe(480);
    expect(db.rows[0]?.height).toBe(800);
  });

  it("records device='x3', width=528, height=792 for a job converted for X3", async () => {
    const db = new FakeD1();
    const bucket = new FakeR2Bucket(
      new Map([
        [
          outputXtcKey(JOB_ID),
          { size: 1234, customMetadata: { title: "Book", device: "x3", width: "528", height: "792" } },
        ],
      ]),
    );

    const result = await saveJobToLibrary(fakeEnv(bucket, db), ACCOUNT, { jobId: JOB_ID });

    expect(result.item.device).toBe("x3");
    expect(result.item.width).toBe(528);
    expect(result.item.height).toBe(792);
  });

  it("falls back to x3/528/792 when the source object predates device metadata (legacy job)", async () => {
    const db = new FakeD1();
    const bucket = new FakeR2Bucket(
      new Map([[outputXtcKey(JOB_ID), { size: 1234, customMetadata: { title: "Book" } }]]),
    );

    const result = await saveJobToLibrary(fakeEnv(bucket, db), ACCOUNT, { jobId: JOB_ID });

    expect(result.item.device).toBe("x3");
    expect(result.item.width).toBe(528);
    expect(result.item.height).toBe(792);
  });
});
