// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Page-range syntax for PdfConvertOptions.pages (spec §5.4):
 *
 *   "1"           single page
 *   "1-10"        range
 *   "1,3,5"       list
 *   "1-4,7,10-12" mixed list of singles and ranges
 *   "5-"          5th page through the last page
 *   "-3"          1st page through the 3rd page
 *   "1-"          all pages
 *
 * Invalid per spec: "0", "-0", "3-1" (reversed), "1,,3" (empty segment),
 * "1-a" (non-numeric), "1-3-5" (too many dashes). A page repeated across
 * segments keeps only its first occurrence (spec §5.4).
 *
 * The Worker (src/pdf-upload.ts) never opens the uploaded PDF (spec §10.3:
 * never buffer the whole file), so it cannot resolve "5-"/"-3"/"1-" to
 * concrete page numbers or know whether a page number is in range — it can
 * only validate the string's *syntax*, via validatePageRangeSyntax. The
 * Container independently implements the equivalent resolution in Python
 * against the PDF it actually opened (spec §11). resolvePageRange exists
 * here to pin down that resolution's exact semantics under test (spec
 * §16.1's "0ページ/逆順/不正文字/ページ数外/選択ページ数上限" cases), not to run
 * in the Worker in production.
 */

const SINGLE = /^[1-9]\d*$/;
const RANGE = /^([1-9]\d*)-([1-9]\d*)$/;
const OPEN_END = /^([1-9]\d*)-$/;
const OPEN_START = /^-([1-9]\d*)$/;

/**
 * Validates only the string syntax (no page-count knowledge required).
 * Returns null when valid, an error message otherwise.
 */
export function validatePageRangeSyntax(spec: string): string | null {
  if (typeof spec !== "string" || spec.length === 0) {
    return "pages must not be empty";
  }
  for (const segment of spec.split(",")) {
    if (segment.length === 0) {
      return "pages contains an empty segment";
    }
    if (SINGLE.test(segment) || OPEN_END.test(segment) || OPEN_START.test(segment)) {
      continue;
    }
    const range = segment.match(RANGE);
    if (range) {
      if (Number(range[1]) > Number(range[2])) {
        return `pages range "${segment}" is reversed`;
      }
      continue;
    }
    return `pages segment "${segment}" is invalid`;
  }
  return null;
}

export type PageRangeResult =
  | { ok: true; pages: number[] }
  | { ok: false; error: string };

/**
 * Resolves `spec` to a deduplicated, first-occurrence-order list of 1-based
 * page numbers against a known `totalPages`, capped at `maxSelectedPages`.
 * Requires totalPages: without an open PDF there is nothing to resolve
 * "5-"/"-3"/"1-" against (see the module doc — the Worker only calls
 * validatePageRangeSyntax, never this function, in production).
 */
export function resolvePageRange(
  spec: string,
  totalPages: number,
  maxSelectedPages: number,
): PageRangeResult {
  const syntaxError = validatePageRangeSyntax(spec);
  if (syntaxError !== null) {
    return { ok: false, error: syntaxError };
  }
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    return { ok: false, error: "totalPages must be a positive integer" };
  }

  const seen = new Set<number>();
  const pages: number[] = [];

  for (const segment of spec.split(",")) {
    const [start, end] = resolveSegment(segment, totalPages);
    if (start > totalPages) {
      return { ok: false, error: `pages segment "${segment}" is out of range` };
    }
    const cappedEnd = Math.min(end, totalPages);
    for (let page = start; page <= cappedEnd; page++) {
      if (!seen.has(page)) {
        seen.add(page);
        pages.push(page);
      }
    }
  }

  if (pages.length === 0) {
    return { ok: false, error: "no pages selected" };
  }
  if (pages.length > maxSelectedPages) {
    return {
      ok: false,
      error: `too many pages selected (max ${maxSelectedPages})`,
    };
  }
  return { ok: true, pages };
}

/** Resolves one already-syntax-valid segment to a concrete [start, end] pair. */
function resolveSegment(segment: string, totalPages: number): [number, number] {
  if (SINGLE.test(segment)) {
    const page = Number(segment);
    return [page, page];
  }
  const range = segment.match(RANGE);
  if (range) {
    return [Number(range[1]), Number(range[2])];
  }
  const openEnd = segment.match(OPEN_END);
  if (openEnd) {
    return [Number(openEnd[1]), totalPages];
  }
  const openStart = segment.match(OPEN_START);
  if (openStart) {
    return [1, Number(openStart[1])];
  }
  // Unreachable: validatePageRangeSyntax already rejected anything else.
  throw new Error(`unreachable: invalid segment "${segment}"`);
}
