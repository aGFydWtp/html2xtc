// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptOpdsCursor } from "../src/integrations/opds/cursor-crypto";
import { genericAdapter } from "../src/integrations/opds/providers/generic";
import {
  createOrReplaceOpdsConnection,
  fetchOpdsCatalogPage,
  startOpdsImport,
} from "../src/integrations/opds/service";
import type { OpdsApiPublicationEntry } from "../src/integrations/opds/service";
import { ApiError } from "../src/security/errors";

function makeKey(byte: number): string {
  const bytes = new Uint8Array(32).fill(byte);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const MINIMAL_FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Catalog</title></feed>`;

class FakeD1 {
  rows: Record<string, unknown>[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    return Promise.all(statements.map((s) => s.run()));
  }
}

class FakeStatement {
  args: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT id FROM opds_connections WHERE account_id")) {
      const [accountId, provider, name] = this.args as [string, string, string];
      const row = this.db.rows.find(
        (r) => r.account_id === accountId && r.provider === provider && r.name === name,
      );
      return (row ? { id: row.id } : null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM opds_connections WHERE id = ?")) {
      const [id, accountId] = this.args as [string, string];
      const row = this.db.rows.find((r) => r.id === id && r.account_id === accountId);
      return (row ?? null) as T | null;
    }
    throw new Error(`FakeD1: unhandled SQL in first(): ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM opds_connections WHERE account_id = ? ORDER BY")) {
      const [accountId] = this.args as [string];
      return { results: this.db.rows.filter((r) => r.account_id === accountId) as T[] };
    }
    throw new Error(`FakeD1: unhandled SQL in all(): ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("DELETE FROM opds_connections WHERE account_id = ? AND provider = ? AND name = ?")) {
      const [accountId, provider, name] = this.args as [string, string, string];
      const before = this.db.rows.length;
      this.db.rows = this.db.rows.filter(
        (r) => !(r.account_id === accountId && r.provider === provider && r.name === name),
      );
      return { meta: { changes: before - this.db.rows.length } };
    }
    if (this.sql.startsWith("DELETE FROM opds_connections WHERE id = ? AND account_id = ?")) {
      const [id, accountId] = this.args as [string, string];
      const before = this.db.rows.length;
      this.db.rows = this.db.rows.filter((r) => !(r.id === id && r.account_id === accountId));
      return { meta: { changes: before - this.db.rows.length } };
    }
    if (this.sql.startsWith("INSERT INTO opds_connections")) {
      const [
        id,
        account_id,
        name,
        provider,
        auth_type,
        catalog_url_ciphertext,
        catalog_url_iv,
        catalog_url_auth_tag,
        username_ciphertext,
        username_iv,
        username_auth_tag,
        password_ciphertext,
        password_iv,
        password_auth_tag,
        origin,
        host,
        created_at,
        updated_at,
        last_verified_at,
      ] = this.args;
      this.db.rows.push({
        id,
        account_id,
        name,
        provider,
        auth_type,
        catalog_url_ciphertext,
        catalog_url_iv,
        catalog_url_auth_tag,
        username_ciphertext,
        username_iv,
        username_auth_tag,
        password_ciphertext,
        password_iv,
        password_auth_tag,
        origin,
        host,
        created_at,
        updated_at,
        last_verified_at,
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled SQL in run(): ${this.sql}`);
  }
}

function buildEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    APP_DB: new FakeD1(),
    OPDS_CONNECTION_ENCRYPTION_KEY: makeKey(1),
    OPDS_CURSOR_ENCRYPTION_KEY: makeKey(2),
    MAX_UPLOAD_EPUB_BYTES: "50331648",
    ...overrides,
  };
}

describe("createOrReplaceOpdsConnection", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(MINIMAL_FEED, { headers: { "Content-Type": "application/atom+xml" } })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a memlane connection with authType=url_secret and returns a summary without secrets", async () => {
    const env = buildEnv();
    const result = await createOrReplaceOpdsConnection(env as never, "acct-1", {
      name: "Memlane",
      provider: "memlane",
      authType: "url_secret",
      catalogUrl: "https://opds.example.com/secret/catalog",
    });
    expect(result.connection.provider).toBe("memlane");
    expect(result.connection.host).toBe("opds.example.com");
    expect(JSON.stringify(result.connection)).not.toContain("secret/catalog");
  });

  it("rejects memlane + basic (provider/authType mismatch)", async () => {
    const env = buildEnv();
    await expect(
      createOrReplaceOpdsConnection(env as never, "acct-1", {
        name: "Memlane",
        provider: "memlane",
        authType: "basic",
        catalogUrl: "https://opds.example.com/catalog",
        username: "u",
        password: "p",
      }),
    ).rejects.toThrow(ApiError);
  });

  it("rejects memlane + none", async () => {
    const env = buildEnv();
    await expect(
      createOrReplaceOpdsConnection(env as never, "acct-1", {
        name: "Memlane",
        provider: "memlane",
        authType: "none",
        catalogUrl: "https://opds.example.com/catalog",
      }),
    ).rejects.toThrow(ApiError);
  });

  it("rejects generic + basic without username/password", async () => {
    const env = buildEnv();
    await expect(
      createOrReplaceOpdsConnection(env as never, "acct-1", {
        name: "Home",
        provider: "generic",
        authType: "basic",
        catalogUrl: "https://opds.example.com/catalog",
      }),
    ).rejects.toThrow(ApiError);
  });

  it("accepts generic + none", async () => {
    const env = buildEnv();
    const result = await createOrReplaceOpdsConnection(env as never, "acct-1", {
      name: "Public",
      provider: "generic",
      authType: "none",
      catalogUrl: "https://opds.example.com/catalog",
    });
    expect(result.connection.authType).toBe("none");
  });

  it("accepts generic + basic with username/password and stores them encrypted (not plaintext)", async () => {
    const env = buildEnv();
    await createOrReplaceOpdsConnection(env as never, "acct-1", {
      name: "Home",
      provider: "generic",
      authType: "basic",
      catalogUrl: "https://opds.example.com/catalog",
      username: "reader",
      password: "hunter2",
    });
    const db = env.APP_DB as FakeD1;
    const row = db.rows[0] as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.username_ciphertext).toBeDefined();
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  it("rejects an http catalogUrl", async () => {
    const env = buildEnv();
    await expect(
      createOrReplaceOpdsConnection(env as never, "acct-1", {
        name: "Memlane",
        provider: "memlane",
        authType: "url_secret",
        catalogUrl: "http://opds.example.com/catalog",
      }),
    ).rejects.toThrow(ApiError);
  });

  it("replaces an existing same (account, provider, name) connection with a new connectionId", async () => {
    const env = buildEnv();
    const first = await createOrReplaceOpdsConnection(env as never, "acct-1", {
      name: "Memlane",
      provider: "memlane",
      authType: "url_secret",
      catalogUrl: "https://opds.example.com/secret/catalog-v1",
    });
    const second = await createOrReplaceOpdsConnection(env as never, "acct-1", {
      name: "Memlane",
      provider: "memlane",
      authType: "url_secret",
      catalogUrl: "https://opds.example.com/secret/catalog-v2",
    });
    expect(second.connection.id).not.toBe(first.connection.id);
    const db = env.APP_DB as FakeD1;
    expect(db.rows).toHaveLength(1); // old row replaced, not accumulated
  });

  it("propagates an upstream fetch failure as OPDS_UPSTREAM_ERROR without keeping any prior connection state", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const env = buildEnv();
    await expect(
      createOrReplaceOpdsConnection(env as never, "acct-1", {
        name: "Memlane",
        provider: "memlane",
        authType: "url_secret",
        catalogUrl: "https://opds.example.com/secret/catalog",
      }),
    ).rejects.toThrow(ApiError);
    expect((env.APP_DB as FakeD1).rows).toHaveLength(0);
  });

  it("keeps the existing connection's row untouched when a same-name replacement attempt fails verification (spec §8.3/§26)", async () => {
    const env = buildEnv();
    globalThis.fetch = vi.fn(
      async () => new Response(MINIMAL_FEED, { headers: { "Content-Type": "application/atom+xml" } }),
    ) as unknown as typeof fetch;
    const created = await createOrReplaceOpdsConnection(env as never, "acct-1", {
      name: "Memlane",
      provider: "memlane",
      authType: "url_secret",
      catalogUrl: "https://opds.example.com/secret/catalog-v1",
    });
    const db = env.APP_DB as FakeD1;
    expect(db.rows).toHaveLength(1);
    const originalRow = { ...db.rows[0] };

    globalThis.fetch = vi.fn(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    await expect(
      createOrReplaceOpdsConnection(env as never, "acct-1", {
        name: "Memlane",
        provider: "memlane",
        authType: "url_secret",
        catalogUrl: "https://opds.example.com/secret/catalog-v2",
      }),
    ).rejects.toThrow(ApiError);

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toEqual(originalRow);
    expect((db.rows[0] as Record<string, unknown>).id).toBe(created.connection.id);
  });
});

describe("fetchOpdsCatalogPage", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns OPDS_CONNECTION_NOT_FOUND for an unknown connectionId", async () => {
    const env = buildEnv();
    await expect(fetchOpdsCatalogPage(env as never, "acct-1", "missing-conn", {})).rejects.toThrow(ApiError);
  });

  it("rejects a cursor issued for a different connection", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(MINIMAL_FEED, { headers: { "Content-Type": "application/atom+xml" } }),
    ) as unknown as typeof fetch;
    const env = buildEnv();
    const created = await createOrReplaceOpdsConnection(env as never, "acct-1", {
      name: "Memlane",
      provider: "memlane",
      authType: "url_secret",
      catalogUrl: "https://opds.example.com/secret/catalog",
    });
    const foreignCursor = await encryptOpdsCursor(env as never, {
      accountId: "acct-1",
      connectionId: "some-other-connection-id",
      kind: "navigation",
      url: "https://opds.example.com/secret/sub",
      depth: 1,
    });
    await expect(
      fetchOpdsCatalogPage(env as never, "acct-1", created.connection.id, { cursor: foreignCursor }),
    ).rejects.toThrow(ApiError);
  });

  it("replaces a feed/entry title or author that embeds this connection's origin or any URL scheme (defense-in-depth, spec review #1)", async () => {
    const env = buildEnv();
    globalThis.fetch = vi.fn(
      async () => new Response(MINIMAL_FEED, { headers: { "Content-Type": "application/atom+xml" } }),
    ) as unknown as typeof fetch;
    const created = await createOrReplaceOpdsConnection(env as never, "acct-1", {
      name: "Memlane",
      provider: "memlane",
      authType: "url_secret",
      catalogUrl: "https://opds.example.com/secret/catalog",
    });

    const CATALOG_FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>https://opds.example.com/secret/catalog-title</title>
      <entry>
        <id>urn:uuid:1</id>
        <title>https://evil.example.com/leak</title>
        <author><name>Jane Doe</name></author>
        <link rel="http://opds-spec.org/acquisition" href="/book1.epub" type="application/epub+zip"/>
      </entry>
      <entry>
        <id>urn:uuid:2</id>
        <title>Plain Book</title>
        <author><name>https://opds.example.com/secret/author</name></author>
        <link rel="http://opds-spec.org/acquisition" href="/book2.epub" type="application/epub+zip"/>
      </entry>
    </feed>`;
    globalThis.fetch = vi.fn(
      async () => new Response(CATALOG_FEED, { headers: { "Content-Type": "application/atom+xml" } }),
    ) as unknown as typeof fetch;

    const page = await fetchOpdsCatalogPage(env as never, "acct-1", created.connection.id, {});
    expect(page.title).toBe("(hidden)");
    const [entry1, entry2] = page.entries as OpdsApiPublicationEntry[];
    expect(entry1?.title).toBe("(hidden)"); // any URL scheme, not just this connection's own
    expect(entry1?.author).toBe("Jane Doe");
    expect(entry2?.title).toBe("Plain Book");
    expect(entry2?.author).toBeNull(); // embedded this connection's own origin

    // The response overall must never leak the secret path segment.
    expect(JSON.stringify(page)).not.toContain("secret");
  });

  it("issues an acquisition cursor via isAllowedAcquisitionUrl, not isAllowedNavigationUrl (spec review #4)", async () => {
    const env = buildEnv();
    globalThis.fetch = vi.fn(
      async () => new Response(MINIMAL_FEED, { headers: { "Content-Type": "application/atom+xml" } }),
    ) as unknown as typeof fetch;
    const created = await createOrReplaceOpdsConnection(env as never, "acct-1", {
      name: "Generic",
      provider: "generic",
      authType: "none",
      catalogUrl: "https://opds.example.com/catalog",
    });

    const FEED_WITH_ACQUISITION = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Catalog</title>
      <entry>
        <id>urn:uuid:1</id>
        <title>Book</title>
        <link rel="http://opds-spec.org/acquisition" href="/book.epub" type="application/epub+zip"/>
      </entry>
    </feed>`;
    globalThis.fetch = vi.fn(
      async () => new Response(FEED_WITH_ACQUISITION, { headers: { "Content-Type": "application/atom+xml" } }),
    ) as unknown as typeof fetch;

    // If issueCursorOrNull mistakenly used the navigation policy for an
    // acquisition_epub cursor (the pre-fix behavior), this would make the
    // acquisition link's own URL fail the (wrong) check and canImportEpub
    // would come back false even though isAllowedAcquisitionUrl says yes.
    const navSpy = vi
      .spyOn(genericAdapter, "isAllowedNavigationUrl")
      .mockImplementation((_connection, url) => !url.pathname.includes("book.epub"));
    const acqSpy = vi.spyOn(genericAdapter, "isAllowedAcquisitionUrl").mockReturnValue(true);

    try {
      const page = await fetchOpdsCatalogPage(env as never, "acct-1", created.connection.id, {});
      const entry = page.entries[0] as OpdsApiPublicationEntry;
      expect(entry.canImportEpub).toBe(true);
      expect(entry.acquisitionCursor).not.toBeNull();
      expect(acqSpy).toHaveBeenCalled();
    } finally {
      navSpy.mockRestore();
      acqSpy.mockRestore();
    }
  });
});

describe("startOpdsImport", () => {
  it("rejects a malformed acquisitionCursor", async () => {
    const env = buildEnv();
    await expect(
      startOpdsImport(env as never, "acct-1", "conn-1", {
        acquisitionCursor: "not-a-real-cursor",
        epubOptions: {
          layout: "auto",
          font: "BIZ UDMincho",
          fontSizePx: 24,
          marginPx: 40,
          chapterPageBreak: true,
          includeCover: true,
          includeTableOfContents: false,
          device: "x3",
        },
      }),
    ).rejects.toThrow(ApiError);
  });

  it("rejects a cursor whose kind is not acquisition_epub", async () => {
    const env = buildEnv();
    const navCursor = await encryptOpdsCursor(env as never, {
      accountId: "acct-1",
      connectionId: "conn-1",
      kind: "navigation",
      url: "https://opds.example.com/secret/sub",
      depth: 1,
    });
    await expect(
      startOpdsImport(env as never, "acct-1", "conn-1", {
        acquisitionCursor: navCursor,
        epubOptions: {
          layout: "auto",
          font: "BIZ UDMincho",
          fontSizePx: 24,
          marginPx: 40,
          chapterPageBreak: true,
          includeCover: true,
          includeTableOfContents: false,
          device: "x3",
        },
      }),
    ).rejects.toThrow(ApiError);
  });

  it("rejects invalid epubOptions", async () => {
    const env = buildEnv();
    const cursor = await encryptOpdsCursor(env as never, {
      accountId: "acct-1",
      connectionId: "conn-1",
      kind: "acquisition_epub",
      url: "https://opds.example.com/secret/book.epub",
      depth: 1,
    });
    await expect(
      startOpdsImport(env as never, "acct-1", "conn-1", {
        acquisitionCursor: cursor,
        epubOptions: { layout: "not-a-real-layout" },
      }),
    ).rejects.toThrow(ApiError);
  });
});
