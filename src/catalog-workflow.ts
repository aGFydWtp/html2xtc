// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { unzipSync } from "fflate";
import * as Papa from "papaparse";
import {
  aggregateCatalog,
  buildGeneration,
  CatalogValidationError,
  chunk,
  stripBom,
  validateCatalogHeaders,
} from "./catalog";
import type {
  AozoraBookRow,
  AozoraContributorRow,
  CatalogCsvRecord,
} from "./catalog";
import {
  acquireCatalogSyncLock,
  activateGeneration,
  beginCatalogSyncRun,
  countGeneration,
  deleteOldGenerations,
  getCatalogState,
  markCatalogSyncCompleted,
  markCatalogSyncFailed,
  markCatalogSyncSkipped,
  markCatalogSyncUnchanged,
  releaseCatalogSyncLock,
  upsertBookChunk,
  upsertContributorChunk,
} from "./catalog-db";
import type { CatalogSourceInfo, CatalogState } from "./catalog-db";
import {
  catalogBookChunkKey,
  catalogContributorChunkKey,
  catalogSourceZipKey,
  catalogSyncPrefix,
} from "./catalog-keys";
import type { AozoraCatalogSyncParams, Env } from "./types";

/** Official UTF-8, extended, zipped person/work catalog. */
const AOZORA_CATALOG_URL =
  "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip";

const SOURCE_FETCH_TIMEOUT_MS = 60_000;
/** Refuse an implausibly large download before buffering it (guards memory). */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
/** Lock lifetime: long enough for a full sync, bounded so a killed run recovers. */
const LOCK_TTL_MINUTES = 120;

const BOOK_CHUNK_SIZE = 200;
const CONTRIBUTOR_CHUNK_SIZE = 200;

/**
 * Sanity floor on the loaded catalog. Aozora held ~17,800 works in mid-2026;
 * anything under 10,000 signals a truncated / wrong source rather than a real
 * shrink, so the generation is rejected instead of going active.
 */
const MIN_EXPECTED_BOOKS = 10_000;
/** Nearly every work has a 図書カードURL; a lower ratio means bad parsing. */
const MIN_CARD_URL_RATIO = 0.9;
/** Reject a generation that lost more than 20% of books vs the active one. */
const MIN_RETAINED_BOOK_RATIO = 0.8;

/** Small metadata returned by the fetch step (never the ZIP bytes). */
interface FetchSourceResult {
  changed: boolean;
  sha256: string | null;
  etag: string | null;
  lastModified: string | null;
}

/** Small metadata returned by the parse step (never the row arrays). */
interface ParsedCatalogManifest {
  sourceRowCount: number;
  bookCount: number;
  contributorCount: number;
  bookChunkCount: number;
  contributorChunkCount: number;
}

/**
 * Daily Aozora Bunko catalog sync, started by scheduled() (src/index.ts).
 * Each step is self-contained and idempotent: fetch → parse-to-R2-chunks →
 * generation-scoped D1 loads → validate → atomic active-generation switch →
 * cleanup. Large data always rides R2; steps return only small JSON (1 MiB
 * cap). A time-boxed lock (LOCK_TTL_MINUTES) lets a killed run recover even if
 * the catch block never runs. See the plan doc for the full rationale.
 */
export class AozoraCatalogSyncWorkflow extends WorkflowEntrypoint<
  Env,
  AozoraCatalogSyncParams
> {
  async run(
    event: WorkflowEvent<AozoraCatalogSyncParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const runId = event.instanceId;
    const { scheduledTime } = event.payload;
    const db = this.env.AOZORA_DB;

    const lock = await step.do(
      "acquire-lock",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => {
        const now = Date.now();
        return acquireLock(db, runId, now);
      },
    );

    if (!lock.acquired) {
      // Another sync holds an unexpired lock; record the skip and stop.
      await step.do("mark-skipped-locked", async () => {
        await markCatalogSyncSkipped(db, runId, AOZORA_CATALOG_URL, nowIso());
      });
      return;
    }

    try {
      await this.runSync(step, runId, scheduledTime);
    } catch (error) {
      // Record the failure and hand the lock back so the next run is not
      // blocked for the full TTL. A step kill that skips this still recovers
      // via lock expiry.
      await step.do("mark-failed", async () => {
        await markCatalogSyncFailed(db, runId, describeError(error), nowIso());
        await releaseCatalogSyncLock(db, runId);
      });
      throw error;
    }
  }

  /** The locked critical section: everything between acquire and release. */
  private async runSync(
    step: WorkflowStep,
    runId: string,
    scheduledTime: number,
  ): Promise<void> {
    const db = this.env.AOZORA_DB;

    const state = await step.do(
      "begin-run",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => {
        await beginCatalogSyncRun(db, runId, AOZORA_CATALOG_URL, nowIso());
        const current = await getCatalogState(db);
        if (current === null) {
          throw new NonRetryableError(
            "aozora_catalog_state row is missing; apply migrations first",
          );
        }
        return current;
      },
    );

    const source = await step.do(
      "fetch-source",
      { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => fetchSource(this.env, runId, state),
    );

    if (!source.changed) {
      // 304 or an identical SHA-256: nothing to load, keep the active
      // generation and release the lock.
      await step.do("mark-unchanged", async () => {
        await markCatalogSyncUnchanged(
          db,
          runId,
          { sha256: source.sha256 ?? undefined, etag: source.etag, lastModified: source.lastModified },
          nowIso(),
        );
        await releaseCatalogSyncLock(db, runId);
      });
      return;
    }

    const sha256 = source.sha256;
    if (sha256 === null) {
      // "changed" always carries a hash; a null here is a logic error.
      throw new NonRetryableError("changed source is missing its SHA-256");
    }
    const generation = buildGeneration(scheduledTime, sha256);
    const sourceInfo: CatalogSourceInfo = {
      sha256,
      etag: source.etag,
      lastModified: source.lastModified,
    };

    const manifest = await step.do(
      "parse-source",
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => parseSource(this.env, runId, generation),
    );

    // One step per chunk keeps each D1 batch small and lets a single failed
    // chunk retry without redoing the rest. UPSERT makes retries idempotent.
    for (let index = 0; index < manifest.bookChunkCount; index += 1) {
      await step.do(
        `load-books-${pad(index)}`,
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => {
          const key = catalogBookChunkKey(runId, index);
          const object = await this.env.XTC_BUCKET.get(key);
          if (object === null) {
            throw new NonRetryableError(`missing R2 object: ${key}`);
          }
          const books = await object.json<AozoraBookRow[]>();
          await upsertBookChunk(db, books);
        },
      );
    }

    for (let index = 0; index < manifest.contributorChunkCount; index += 1) {
      await step.do(
        `load-contributors-${pad(index)}`,
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => {
          const key = catalogContributorChunkKey(runId, index);
          const object = await this.env.XTC_BUCKET.get(key);
          if (object === null) {
            throw new NonRetryableError(`missing R2 object: ${key}`);
          }
          const contributors = await object.json<AozoraContributorRow[]>();
          await upsertContributorChunk(db, contributors);
        },
      );
    }

    await step.do(
      "validate-generation",
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => {
        validateCounts(await countGeneration(db, generation), manifest, state);
      },
    );

    // The atomic switch: from here the *_active views return the new data.
    await step.do(
      "activate-generation",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => {
        const { activated } = await activateGeneration(db, runId, {
          generation,
          ...sourceInfo,
          bookCount: manifest.bookCount,
          contributorCount: manifest.contributorCount,
          successAt: nowIso(),
        });
        if (!activated) {
          throw new NonRetryableError(
            "sync lock was lost before activation; aborting to avoid a split state",
          );
        }
      },
    );

    await step.do("finalize-run", async () => {
      await markCatalogSyncCompleted(db, runId, {
        generation,
        source: sourceInfo,
        sourceRowCount: manifest.sourceRowCount,
        bookCount: manifest.bookCount,
        contributorCount: manifest.contributorCount,
        completedAt: nowIso(),
      });
    });

    // Best-effort cleanup: the sync already succeeded, so a failure here must
    // not fail the run. The next sync retries old-generation deletion, and the
    // R2 lifecycle rule reclaims any intermediate left behind.
    await step.do("delete-old-generations", async () => {
      try {
        await deleteOldGenerations(db, generation);
      } catch (error) {
        console.error(`[${runId}] old-generation cleanup failed`, error);
      }
    });

    await step.do("cleanup-r2", async () => {
      await cleanupR2(this.env, runId, manifest);
    });
  }
}

/** ISO-8601 UTC timestamp; isolated so step bodies read cleanly. */
function nowIso(): string {
  return new Date().toISOString();
}

function pad(index: number): string {
  return index.toString().padStart(4, "0");
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function acquireLock(
  db: D1Database,
  runId: string,
  now: number,
): Promise<{ acquired: boolean }> {
  const nowIsoValue = new Date(now).toISOString();
  const expiresIso = new Date(now + LOCK_TTL_MINUTES * 60_000).toISOString();
  return acquireCatalogSyncLock(db, runId, nowIsoValue, expiresIso);
}

/**
 * Conditional GET of the official ZIP. Returns unchanged on 304 or an
 * identical SHA-256; otherwise stores the ZIP to R2 and returns the new
 * validators. 5xx stays retryable (thrown Error); a 4xx is a non-retryable
 * source defect.
 */
async function fetchSource(
  env: Env,
  runId: string,
  state: CatalogState,
): Promise<FetchSourceResult> {
  const headers = new Headers({
    Accept: "application/zip",
    "User-Agent":
      "html2xtc-aozora-catalog-sync/1.0 (+https://xtc.hr20k.com/about)",
  });
  if (state.sourceEtag) {
    headers.set("If-None-Match", state.sourceEtag);
  }
  if (state.sourceLastModified) {
    headers.set("If-Modified-Since", state.sourceLastModified);
  }

  const response = await fetch(AOZORA_CATALOG_URL, {
    headers,
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });

  if (response.status === 304) {
    return {
      changed: false,
      sha256: state.sourceSha256,
      etag: state.sourceEtag,
      lastModified: state.sourceLastModified,
    };
  }
  if (response.status >= 500) {
    throw new Error(`aozora source returned ${response.status}`);
  }
  if (!response.ok) {
    throw new NonRetryableError(`aozora source returned ${response.status}`);
  }

  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && Number(contentLength) > MAX_SOURCE_BYTES) {
    throw new NonRetryableError(
      `aozora source Content-Length ${contentLength} exceeds ${MAX_SOURCE_BYTES}`,
    );
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new NonRetryableError(
      `aozora source body ${bytes.byteLength} exceeds ${MAX_SOURCE_BYTES}`,
    );
  }

  const sha256 = await sha256Hex(bytes);
  if (sha256 === state.sourceSha256) {
    // Server ignored the validators but the bytes are identical.
    return {
      changed: false,
      sha256,
      etag: response.headers.get("ETag") ?? state.sourceEtag,
      lastModified: response.headers.get("Last-Modified") ?? state.sourceLastModified,
    };
  }

  await env.XTC_BUCKET.put(catalogSourceZipKey(runId), bytes, {
    httpMetadata: { contentType: "application/zip" },
  });

  return {
    changed: true,
    sha256,
    etag: response.headers.get("ETag"),
    lastModified: response.headers.get("Last-Modified"),
  };
}

/**
 * Reads the stored ZIP back, unzips the single CSV, parses it by header name,
 * aggregates works + contributors, and writes R2 chunks. Returns only counts.
 * All defects here are deterministic, so they surface as NonRetryableError.
 */
async function parseSource(
  env: Env,
  runId: string,
  generation: string,
): Promise<ParsedCatalogManifest> {
  const object = await env.XTC_BUCKET.get(catalogSourceZipKey(runId));
  if (object === null) {
    throw new NonRetryableError(
      `missing R2 object: ${catalogSourceZipKey(runId)}`,
    );
  }
  const zipBytes = new Uint8Array(await object.arrayBuffer());

  let csvText: string;
  try {
    const archive = unzipSync(zipBytes);
    const csvEntries = Object.entries(archive).filter(([name]) =>
      name.toLowerCase().endsWith(".csv"),
    );
    if (csvEntries.length !== 1) {
      throw new NonRetryableError(
        `expected exactly one CSV in the archive, found ${csvEntries.length}`,
      );
    }
    // fatal:true rejects (never silently replaces) invalid UTF-8; strip BOM.
    csvText = stripBom(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        csvEntries[0][1],
      ),
    );
  } catch (error) {
    if (error instanceof NonRetryableError) {
      throw error;
    }
    throw new NonRetryableError(`failed to unzip/decode source: ${describeError(error)}`);
  }

  const parsed = Papa.parse<CatalogCsvRecord>(csvText, {
    header: true,
    skipEmptyLines: "greedy",
  });

  const fields = parsed.meta.fields;
  if (fields === undefined || fields.length === 0) {
    throw new NonRetryableError("CSV has no header row");
  }
  // An unterminated quoted field means structural corruption; field-count
  // mismatches are tolerated (logged) since a stray column must not abort.
  const quoteError = parsed.errors.find((error) => error.type === "Quotes");
  if (quoteError !== undefined) {
    throw new NonRetryableError(
      `CSV parse error (${quoteError.code}) at row ${quoteError.row}: ${quoteError.message}`,
    );
  }
  if (parsed.errors.length > 0) {
    console.error(
      `[${runId}] ${parsed.errors.length} non-fatal CSV parse warning(s); first: ${parsed.errors[0].message}`,
    );
  }

  let books: AozoraBookRow[];
  let contributors: AozoraContributorRow[];
  try {
    validateCatalogHeaders(fields);
    ({ books, contributors } = aggregateCatalog(parsed.data, generation));
  } catch (error) {
    if (error instanceof CatalogValidationError) {
      throw new NonRetryableError(error.message);
    }
    throw error;
  }

  const bookChunks = chunk(books, BOOK_CHUNK_SIZE);
  const contributorChunks = chunk(contributors, CONTRIBUTOR_CHUNK_SIZE);

  for (let index = 0; index < bookChunks.length; index += 1) {
    await env.XTC_BUCKET.put(
      catalogBookChunkKey(runId, index),
      JSON.stringify(bookChunks[index]),
      { httpMetadata: { contentType: "application/json" } },
    );
  }
  for (let index = 0; index < contributorChunks.length; index += 1) {
    await env.XTC_BUCKET.put(
      catalogContributorChunkKey(runId, index),
      JSON.stringify(contributorChunks[index]),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  return {
    sourceRowCount: parsed.data.length,
    bookCount: books.length,
    contributorCount: contributors.length,
    bookChunkCount: bookChunks.length,
    contributorChunkCount: contributorChunks.length,
  };
}

/** Rejects a generation that fails any pre-activation invariant. */
function validateCounts(
  counts: { bookCount: number; contributorCount: number; cardUrlCount: number },
  manifest: ParsedCatalogManifest,
  previous: CatalogState,
): void {
  if (counts.bookCount !== manifest.bookCount) {
    throw new NonRetryableError(
      `book count mismatch: D1 ${counts.bookCount} vs manifest ${manifest.bookCount}`,
    );
  }
  if (counts.contributorCount !== manifest.contributorCount) {
    throw new NonRetryableError(
      `contributor count mismatch: D1 ${counts.contributorCount} vs manifest ${manifest.contributorCount}`,
    );
  }
  if (counts.bookCount < MIN_EXPECTED_BOOKS) {
    throw new NonRetryableError(
      `book count ${counts.bookCount} below the ${MIN_EXPECTED_BOOKS} floor`,
    );
  }
  const cardRatio = counts.bookCount === 0 ? 0 : counts.cardUrlCount / counts.bookCount;
  if (cardRatio < MIN_CARD_URL_RATIO) {
    throw new NonRetryableError(
      `card_url ratio ${cardRatio.toFixed(3)} below ${MIN_CARD_URL_RATIO}`,
    );
  }
  if (
    previous.activeBookCount > 0 &&
    counts.bookCount < previous.activeBookCount * MIN_RETAINED_BOOK_RATIO
  ) {
    throw new NonRetryableError(
      `book count ${counts.bookCount} dropped below ${MIN_RETAINED_BOOK_RATIO} of the previous ${previous.activeBookCount}`,
    );
  }
}

/** Best-effort removal of this run's R2 intermediates after activation. */
async function cleanupR2(
  env: Env,
  runId: string,
  manifest: ParsedCatalogManifest,
): Promise<void> {
  const keys = [catalogSourceZipKey(runId)];
  for (let index = 0; index < manifest.bookChunkCount; index += 1) {
    keys.push(catalogBookChunkKey(runId, index));
  }
  for (let index = 0; index < manifest.contributorChunkCount; index += 1) {
    keys.push(catalogContributorChunkKey(runId, index));
  }
  try {
    await env.XTC_BUCKET.delete(keys);
  } catch (error) {
    console.error(
      `[${runId}] R2 cleanup of ${catalogSyncPrefix(runId)} failed`,
      error,
    );
  }
}

/** Hex-encoded SHA-256 of the given bytes. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
