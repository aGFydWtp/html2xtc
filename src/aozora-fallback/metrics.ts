// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";

/**
 * Diagnostic counts logged/manifested by the Aozora timeout-fallback (spec
 * §13/§21). Deliberately NOT used to decide whether to split (spec §3.2/§27:
 * these numbers did not predict the real 6002 failure in measurement) — only
 * for logging and the manifest's per-chunk record.
 */
export interface ContentMetrics {
  /** Unicode code points, whitespace stripped — same convention as
   * isExtractSufficient (src/extract.ts) and the split target calculation. */
  textLength: number;
  elementCount: number;
  rubyCount: number;
  brCount: number;
  imageCount: number;
}

function metricsFromBody(body: { textContent: string | null; querySelectorAll(sel: string): { length: number } }): ContentMetrics {
  const textLength = Array.from((body.textContent ?? "").replace(/\s+/g, "")).length;
  return {
    textLength,
    elementCount: body.querySelectorAll("*").length,
    rubyCount: body.querySelectorAll("ruby").length,
    brCount: body.querySelectorAll("br").length,
    imageCount: body.querySelectorAll("img").length,
  };
}

/** Metrics for an HTML fragment (no <html>/<body> wrapper — a chunk's content). */
export function computeFragmentMetrics(fragmentHtml: string): ContentMetrics {
  const { document } = parseHTML(
    `<!doctype html><html><body>${fragmentHtml}</body></html>`,
  );
  return metricsFromBody(document.body);
}

/** Metrics for a complete HTML document string (e.g. the stored article.html). */
export function computeDocumentMetrics(fullHtml: string): ContentMetrics {
  const { document } = parseHTML(fullHtml);
  return metricsFromBody(document.body);
}
