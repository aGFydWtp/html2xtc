// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { resolveExtractMinChars } from "./jobs";
import { formatJstTimestamp, RENDER_USER_AGENT } from "./pdf";
import { buildPrintHtml } from "./printhtml";
import type { Env } from "./types";
import { validatePublicUrl } from "./validate";

/**
 * Extract mode: pull the main article content out of the target page and
 * hand the PDF renderer a clean, self-contained HTML document instead of the
 * live URL.
 *
 * The pipeline is fetch-first so browser time (the billable resource) is only
 * spent on pages that need it:
 *
 *   1. plain Worker fetch + Readability          (no browser time)
 *   2. quickAction("content") + Readability      (JS-rendered pages)
 *   3. degrade to full mode (render the URL)     (always produces output)
 *
 * Every failure inside 1-2 is logged and swallowed, never thrown: the full
 * render is the always-works baseline, so extract mode must never fail a
 * conversion that full mode would have completed.
 */

/** Env subset this module needs; keeps tests down to a two-field mock. */
type ExtractEnv = Pick<Env, "BROWSER" | "EXTRACT_MIN_CHARS">;

const SOURCE_FETCH_TIMEOUT_MS = 15_000;
// CPU guard as much as a transfer guard: Readability + linkedom parsing of a
// multi-megabyte page would eat the Worker CPU budget.
const MAX_SOURCE_HTML_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;

/** Normalized Readability output; fields absent instead of null/empty. */
export interface ExtractedArticle {
  title?: string;
  byline?: string;
  siteName?: string;
  lang?: string;
  /** HTML fragment of the article body (unsanitized Readability output). */
  contentHtml: string;
  /** Plain text of the article body, for the quality check. */
  textContent: string;
}

export interface SourceHtml {
  html: string;
  /** URL the HTML actually came from (after redirects); the base for links. */
  finalUrl: URL;
}

/** What the caller should render: prepared HTML, or the URL (full mode). */
export type RenderInput =
  | { kind: "html"; html: string }
  | { kind: "url"; url: string };

/** Injection point for tests, mirroring validate.ts's DnsResolver pattern. */
export type SourceHtmlFetcher = (
  target: URL,
  jobId: string,
) => Promise<SourceHtml | null>;

/**
 * Fetches the target page over plain HTTP. Returns null on anything that
 * should push the pipeline to the next stage: network/timeout errors, non-2xx,
 * non-HTML content types, oversized bodies, undecodable charsets, redirect
 * loops — and redirect targets that fail SSRF re-validation, which the
 * initial validatePublicUrl() call at request time cannot see.
 */
export async function fetchSourceHtml(
  target: URL,
  jobId: string,
): Promise<SourceHtml | null> {
  try {
    let current = target;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const response = await fetch(current.toString(), {
        redirect: "manual",
        headers: {
          "User-Agent": RENDER_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
      });

      if (isRedirectStatus(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("Location");
        if (location === null) {
          return null;
        }
        // Re-validate every hop (throws UrlValidationError -> null below).
        current = await validatePublicUrl(
          new URL(location, current).toString(),
        );
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }

      const contentType = response.headers.get("Content-Type");
      if (
        contentType === null ||
        !/text\/html|application\/xhtml\+xml/i.test(contentType)
      ) {
        await response.body?.cancel();
        return null;
      }

      const bytes = await readBodyCapped(response, MAX_SOURCE_HTML_BYTES);
      if (bytes === null) {
        return null;
      }
      const html = decodeHtml(bytes, contentType);
      if (html === null) {
        return null;
      }
      return { html, finalUrl: current };
    }
    return null; // too many redirects
  } catch (error) {
    console.error(`[${jobId}] source fetch failed for ${target}`, error);
    return null;
  }
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

/**
 * Reads a response body up to `cap` bytes; null (with the body cancelled)
 * once the cap is exceeded, so an unbounded stream can never be buffered.
 */
async function readBodyCapped(
  response: Response,
  cap: number,
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) {
      break;
    }
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Charset detection: Content-Type header first, then a <meta ...charset=...>
 * scan of the first 1 KiB (covers both <meta charset> and the http-equiv
 * form — both contain "charset="). UTF-8 is the fallback. Shift_JIS/EUC-JP
 * sites still exist, so response.text() (UTF-8 only) is not enough here.
 */
function detectCharset(bytes: Uint8Array, contentType: string): string {
  const header = contentType.match(/charset=["']?([^"';\s]+)/i);
  if (header?.[1] !== undefined) {
    return header[1];
  }
  // Charset declarations are ASCII; a latin1 view never throws on any bytes.
  const head = new TextDecoder("iso-8859-1").decode(bytes.subarray(0, 1024));
  const meta = head.match(/<meta[^>]+charset=["']?([^"'\s/>]+)/i);
  return meta?.[1] ?? "utf-8";
}

/** null for charset labels TextDecoder rejects: the browser fallback copes. */
function decodeHtml(bytes: Uint8Array, contentType: string): string | null {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(detectCharset(bytes, contentType));
  } catch {
    return null;
  }
  return decoder.decode(bytes);
}

/**
 * Runs Readability over an HTML string via linkedom. Returns null when no
 * article was found — including when linkedom or Readability throws: their
 * DOM coverage is not guaranteed for every page in the wild, and a parse
 * blowup must mean "fall back", not "fail the job" (same fail-soft stance as
 * the colophon script in pdf.ts).
 */
export function extractArticle(
  html: string,
  url: string,
): ExtractedArticle | null {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
      { charThreshold: 250 },
    ).parse();
    if (
      article === null ||
      typeof article.content !== "string" ||
      typeof article.textContent !== "string"
    ) {
      return null;
    }
    return {
      title: nonEmpty(article.title),
      byline: nonEmpty(article.byline),
      siteName: nonEmpty(article.siteName),
      lang: nonEmpty(article.lang),
      contentHtml: article.content,
      textContent: article.textContent,
    };
  } catch (error) {
    console.error(`extractArticle failed for ${url}`, error);
    return null;
  }
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Quality gate for an extraction result. Character count on whitespace-
 * stripped text, not Readability's own English-tuned heuristics
 * (isProbablyReaderable's minContentLength etc.), which under-count CJK.
 */
export function isExtractSufficient(
  article: ExtractedArticle | null,
  env: Pick<Env, "EXTRACT_MIN_CHARS">,
): article is ExtractedArticle {
  if (article === null) {
    return false;
  }
  const chars = article.textContent.replace(/\s+/g, "").length;
  return chars >= resolveExtractMinChars(env);
}

/**
 * Browser Rendering fallback: fetches the JS-rendered HTML of the page via
 * quickAction("content"). Unlike the pdf action this returns JSON
 * ({ success, result, meta }), and meta.status carries the page's own HTTP
 * status. All failures are null (fail-soft, degrade to full mode).
 */
export async function fetchRenderedHtml(
  env: Pick<Env, "BROWSER">,
  url: string,
  jobId: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await env.BROWSER.quickAction("content", {
      url,
      userAgent: RENDER_USER_AGENT,
      // JS must run — that is the point of this fallback — but nothing is
      // painted: skip images/media/fonts/styles to save browser time.
      rejectResourceTypes: ["image", "media", "font", "stylesheet"],
      gotoOptions: { waitUntil: "networkidle2", timeout: 60_000 },
    });
  } catch (error) {
    console.error(`[${jobId}] content action request failed`, error);
    return null;
  }

  // Billing visibility for the fallback path (Free plan: 10 browser-min/day).
  const msUsed = response.headers.get("X-Browser-Ms-Used");
  if (msUsed !== null) {
    console.log(`[${jobId}] content action used ${msUsed}ms of browser time`);
  }

  if (!response.ok) {
    console.error(
      `[${jobId}] content action returned ${response.status}: ${await response.text()}`,
    );
    return null;
  }
  let body: { success?: boolean; result?: string; meta?: { status?: number } };
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (body.success !== true || typeof body.result !== "string") {
    return null;
  }
  const pageStatus = body.meta?.status;
  if (typeof pageStatus === "number" && pageStatus >= 400) {
    console.error(`[${jobId}] content action: page returned HTTP ${pageStatus}`);
    return null;
  }
  return body.result;
}

/**
 * The extract-mode orchestrator: fetch → extract → (browser render → extract)
 * → degrade to full. Returns prepared print HTML when extraction succeeds,
 * otherwise the original URL for the classic full render. Never throws for
 * extraction problems; the chosen path is logged as
 * "[jobId] extract path: fetch|browser|fallback-full".
 */
export async function prepareRenderInput(
  env: ExtractEnv,
  target: URL,
  jobId: string,
  fetchSource: SourceHtmlFetcher = fetchSourceHtml,
): Promise<RenderInput> {
  const fetched = await fetchSource(target, jobId);
  if (fetched !== null) {
    const article = extractArticle(fetched.html, fetched.finalUrl.toString());
    if (isExtractSufficient(article, env)) {
      console.log(`[${jobId}] extract path: fetch`);
      return {
        kind: "html",
        html: buildPrintHtml(
          article,
          fetched.finalUrl.toString(),
          formatJstTimestamp(new Date()),
        ),
      };
    }
  }

  const rendered = await fetchRenderedHtml(env, target.toString(), jobId);
  if (rendered !== null) {
    // The content action reports no final URL; the submitted URL is the best
    // available base for resolving relative references.
    const article = extractArticle(rendered, target.toString());
    if (isExtractSufficient(article, env)) {
      console.log(`[${jobId}] extract path: browser`);
      return {
        kind: "html",
        html: buildPrintHtml(
          article,
          target.toString(),
          formatJstTimestamp(new Date()),
        ),
      };
    }
  }

  console.log(`[${jobId}] extract path: fallback-full`);
  return { kind: "url", url: target.toString() };
}
