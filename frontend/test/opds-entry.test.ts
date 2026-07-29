// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  dedupeOpdsEntries,
  findConnectionByProvider,
  isImportableEntry,
  mapOpdsErrorCode,
  type OpdsPublicationEntry,
  OPDS_SELECTION_MAX,
  parseCatalogPage,
  parseConnectionSummaries,
  parseConnectionSummary,
  parseOpdsEntry,
  runWithConcurrency,
  summarizeOpdsImportOutcomes,
  toggleOpdsSelection,
} from "../src/lib/opds-entry";

const validConnection = {
  id: "conn-1",
  name: "Memlane",
  provider: "memlane",
  authType: "url_secret",
  host: "memlane.example",
  lastVerifiedAt: "2026-07-29T00:00:00.000Z",
};

describe("parseConnectionSummary", () => {
  it("parses a valid connection", () => {
    expect(parseConnectionSummary(validConnection)).toEqual(validConnection);
  });

  it("defaults lastVerifiedAt to null when missing/non-string", () => {
    const { lastVerifiedAt: _lastVerifiedAt, ...rest } = validConnection;
    expect(parseConnectionSummary(rest)).toEqual({ ...rest, lastVerifiedAt: null });
  });

  it("rejects missing required fields", () => {
    expect(parseConnectionSummary({ ...validConnection, id: undefined })).toBeNull();
    expect(parseConnectionSummary(null)).toBeNull();
    expect(parseConnectionSummary("nope")).toBeNull();
  });

  it("never surfaces a catalogUrl/username/password field even if present on the raw payload", () => {
    const withSecret = { ...validConnection, catalogUrl: "https://secret.example/feed" };
    const parsed = parseConnectionSummary(withSecret);
    expect(parsed).not.toHaveProperty("catalogUrl");
  });
});

describe("parseConnectionSummaries / findConnectionByProvider", () => {
  it("filters out invalid entries and finds by provider", () => {
    const list = parseConnectionSummaries([validConnection, { bogus: true }, "nope"]);
    expect(list).toEqual([validConnection]);
    expect(findConnectionByProvider(list, "memlane")).toEqual(validConnection);
    expect(findConnectionByProvider(list, "kavita")).toBeNull();
  });
});

describe("parseOpdsEntry", () => {
  it("parses a navigation entry", () => {
    expect(parseOpdsEntry({ kind: "navigation", id: "n1", title: "Recents", cursor: "c1" })).toEqual({
      kind: "navigation",
      id: "n1",
      title: "Recents",
      cursor: "c1",
    });
  });

  it("parses a publication entry with nullable fields", () => {
    expect(
      parseOpdsEntry({
        kind: "publication",
        id: "p1",
        title: "本のタイトル",
        canImportEpub: true,
        acquisitionCursor: "c2",
      }),
    ).toEqual({
      kind: "publication",
      id: "p1",
      title: "本のタイトル",
      author: null,
      updatedAt: null,
      canImportEpub: true,
      acquisitionCursor: "c2",
    });
  });

  it("rejects unknown kind or missing required fields", () => {
    expect(parseOpdsEntry({ kind: "other", id: "x", title: "x" })).toBeNull();
    expect(parseOpdsEntry({ kind: "navigation", id: "n1", title: "x" })).toBeNull();
    expect(parseOpdsEntry({ kind: "publication", id: "p1", title: "x" })).toBeNull();
  });
});

describe("parseCatalogPage", () => {
  it("parses a full page", () => {
    const raw = {
      title: "Memlane",
      entries: [
        { kind: "navigation", id: "n1", title: "Recents", cursor: "c1" },
        { kind: "publication", id: "p1", title: "本", canImportEpub: true, acquisitionCursor: "c2" },
        { bogus: true },
      ],
      nextCursor: "next",
      previousCursor: null,
      searchSupported: true,
      searchCursor: "search",
    };
    const page = parseCatalogPage(raw);
    expect(page?.title).toBe("Memlane");
    expect(page?.entries).toHaveLength(2);
    expect(page?.nextCursor).toBe("next");
    expect(page?.previousCursor).toBeNull();
    expect(page?.searchSupported).toBe(true);
    expect(page?.searchCursor).toBe("search");
  });

  it("rejects a page missing required fields", () => {
    expect(parseCatalogPage({ entries: [] })).toBeNull();
    expect(parseCatalogPage(null)).toBeNull();
  });

  it("drops duplicate entry ids so {#each ... (entry.id)} never sees a duplicate key", () => {
    const raw = {
      title: "Memlane",
      entries: [
        { kind: "publication", id: "p1", title: "本1", canImportEpub: true, acquisitionCursor: "c1" },
        { kind: "publication", id: "p1", title: "本1 重複", canImportEpub: true, acquisitionCursor: "c1-dup" },
        { kind: "navigation", id: "p1", title: "衝突するnavigation", cursor: "c2" },
      ],
      nextCursor: null,
      previousCursor: null,
      searchSupported: false,
      searchCursor: null,
    };
    const page = parseCatalogPage(raw);
    expect(page?.entries).toHaveLength(1);
    // 先勝ち: 最初に出現したentryが残る
    expect(page?.entries[0]).toMatchObject({ id: "p1", title: "本1" });
  });
});

describe("dedupeOpdsEntries", () => {
  it("keeps the first occurrence and drops later entries with the same id", () => {
    const entries = [
      parseOpdsEntry({ kind: "publication", id: "a", title: "A", canImportEpub: true, acquisitionCursor: "ca" })!,
      parseOpdsEntry({ kind: "publication", id: "b", title: "B", canImportEpub: true, acquisitionCursor: "cb" })!,
      parseOpdsEntry({ kind: "publication", id: "a", title: "A dup", canImportEpub: true, acquisitionCursor: "ca2" })!,
    ];
    const deduped = dedupeOpdsEntries(entries);
    expect(deduped.map((e) => e.id)).toEqual(["a", "b"]);
    expect(deduped[0].title).toBe("A");
  });

  it("returns entries unchanged when ids are already unique", () => {
    const entries = [
      parseOpdsEntry({ kind: "navigation", id: "n1", title: "N", cursor: "c1" })!,
      parseOpdsEntry({ kind: "publication", id: "p1", title: "P", canImportEpub: true, acquisitionCursor: "c2" })!,
    ];
    expect(dedupeOpdsEntries(entries)).toEqual(entries);
  });
});

describe("isImportableEntry", () => {
  it("rejects navigation entries", () => {
    expect(isImportableEntry({ kind: "navigation", id: "n1", title: "x", cursor: "c" })).toBe(false);
  });

  it("rejects publications without EPUB acquisition", () => {
    expect(
      isImportableEntry({
        kind: "publication",
        id: "p1",
        title: "x",
        author: null,
        updatedAt: null,
        canImportEpub: false,
        acquisitionCursor: null,
      }),
    ).toBe(false);
  });

  it("rejects publications with canImportEpub true but no acquisition cursor", () => {
    expect(
      isImportableEntry({
        kind: "publication",
        id: "p1",
        title: "x",
        author: null,
        updatedAt: null,
        canImportEpub: true,
        acquisitionCursor: null,
      }),
    ).toBe(false);
  });

  it("accepts an EPUB-importable publication", () => {
    expect(
      isImportableEntry({
        kind: "publication",
        id: "p1",
        title: "x",
        author: null,
        updatedAt: null,
        canImportEpub: true,
        acquisitionCursor: "c1",
      }),
    ).toBe(true);
  });
});

function pub(id: string): OpdsPublicationEntry {
  return { kind: "publication", id, title: id, author: null, updatedAt: null, canImportEpub: true, acquisitionCursor: `cur-${id}` };
}

describe("toggleOpdsSelection", () => {
  it("adds and removes entries", () => {
    let selected = new Map<string, OpdsPublicationEntry>();
    selected = toggleOpdsSelection(selected, pub("a"), true);
    expect(selected.has("a")).toBe(true);
    selected = toggleOpdsSelection(selected, pub("a"), false);
    expect(selected.has("a")).toBe(false);
  });

  it("ignores duplicate adds", () => {
    let selected = new Map<string, OpdsPublicationEntry>();
    selected = toggleOpdsSelection(selected, pub("a"), true);
    const again = toggleOpdsSelection(selected, pub("a"), true);
    expect(again).toBe(selected); // 変化なし: 同一参照を返す
  });

  it("caps at the maximum selection count", () => {
    let selected = new Map<string, OpdsPublicationEntry>();
    for (const id of ["a", "b", "c", "d", "e"]) selected = toggleOpdsSelection(selected, pub(id), true, 5);
    expect(selected.size).toBe(OPDS_SELECTION_MAX);
    const attempt = toggleOpdsSelection(selected, pub("f"), true, 5);
    expect(attempt.size).toBe(5);
    expect(attempt.has("f")).toBe(false);
  });
});

describe("summarizeOpdsImportOutcomes", () => {
  it("counts successes and failures", () => {
    expect(
      summarizeOpdsImportOutcomes([
        { id: "1", ok: true },
        { id: "2", ok: true },
        { id: "3", ok: false },
      ]),
    ).toEqual({ startedCount: 2, failedCount: 1 });
  });

  it("handles an empty list", () => {
    expect(summarizeOpdsImportOutcomes([])).toEqual({ startedCount: 0, failedCount: 0 });
  });
});

describe("runWithConcurrency", () => {
  it("runs all items and preserves result order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithConcurrency(items, 2, async (n) => n * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("caps in-flight work at the given limit", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    let inFlight = 0;
    let maxInFlight = 0;
    await runWithConcurrency(items, 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("continues past a worker that reports failure without throwing", async () => {
    const items = ["a", "b", "c"];
    const results = await runWithConcurrency(items, 2, async (id) => ({ id, ok: id !== "b" }));
    expect(results).toEqual([
      { id: "a", ok: true },
      { id: "b", ok: false },
      { id: "c", ok: true },
    ]);
  });
});

describe("mapOpdsErrorCode", () => {
  it("maps known codes", () => {
    expect(mapOpdsErrorCode("OPDS_FEED_INVALID")).toBe("memlane_feed_invalid");
    expect(mapOpdsErrorCode("OPDS_CONNECTION_NOT_FOUND")).toBe("memlane_session_expired");
    expect(mapOpdsErrorCode("OPDS_IMPORT_DISABLED")).toBe("memlane_import_disabled");
  });

  it("returns null for unknown or missing codes", () => {
    expect(mapOpdsErrorCode("OPDS_SOMETHING_ELSE")).toBeNull();
    expect(mapOpdsErrorCode(null)).toBeNull();
  });
});
