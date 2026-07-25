// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";
import { computeFragmentMetrics } from "./metrics";
import type { ContentMetrics } from "./metrics";

/**
 * DOM-order 4-way split of an Aozora article's sanitized content fragment
 * (the innerHTML of the print document's content <div> — see
 * src/aozora-fallback/html.ts) into 4 balanced, non-empty, order-preserving
 * pieces (spec §14).
 *
 * Implementation notes against the spec's boundary-candidate priority list
 * (§14 "境界候補の優先順位"). `scoreBoundary()` was revised (see
 * `aozora-fallback-boundary-improvement-spec.md`) after real Aozora reader
 * HTML (e.g. 神曲 02 浄火 — div-less, heading-less, `<br>`-delimited text
 * with `<span class="notes">` page-break notes) showed the original tier
 * order produced mid-line and mid-chapter cuts. Current tiers, lower wins:
 *
 *   1. 直前の実体セグメントが改ページ -> `<hr>`, a class containing "page",
 *      or (added) a `<span class="notes">` whose trimmed text content is
 *      exactly `［＃改ページ／改丁／改見開き／改段］` — Aozora reader HTML's
 *      actual page-break marker, matching the same notation set
 *      `packages/aozora-text/src/parse-document.ts` recognizes on the TXT
 *      path. "直前の実体セグメント" skips `<br>`/whitespace fillers via
 *      `previousMeaningful()`, so trailing `<br>`s after the marker don't
 *      hide it.
 *   2. 次が見出し        -> segment.isHeading (h1-h4), unchanged.
 *   3. 次がdiv/section   -> segment.isBlock, unchanged (collapses spec tiers
 *      3 and 5; see original rationale below).
 *   4. 連続br（2本以上） -> `precedingBreakRun()` counts consecutive `<br>`
 *      segments before the boundary, skipping whitespace-only text-node
 *      fillers in between (Aozora reader HTML emits `<br>\r\n<br>`, where the
 *      `\r\n` is its own zero-length text segment — the original
 *      `segments[i-2].isBr` check did not skip these and so never fired on
 *      real documents; see spec §4.2). A run of 2+ is treated as a blank
 *      line, i.e. a chapter/paragraph break.
 *   5. 単一br かつ直前が文末 -> a single preceding `<br>` where the previous
 *      meaningful segment's text ends in a sentence terminator
 *      (。」』.!?) — end-of-line AND end-of-sentence together.
 *   6. 単一br（行末のみ） -> a single preceding `<br>` regardless of
 *      sentence-final punctuation. Ranked below tier 4/5 deliberately: the
 *      original scorer treated "prev.endsSentence" (mid-line sentence ends,
 *      since it never checked for a following line break) ABOVE consecutive
 *      `<br>` runs, which combined with tier 4's dead check above meant a
 *      sentence-final punctuation mark mid-line beat a real blank-line
 *      chapter break — the cause of the mid-line cut in spec §3.3/§4.3.
 *   7. 直前がdiv/section -> segment.isBlock on the previous meaningful
 *      segment (was tier 5 pre-revision).
 *   8. 子要素境界（行の途中）-> the fallback: any remaining inter-segment
 *      boundary, used only when nothing better is in range — this is what
 *      makes the search always terminate.
 *   9. `<br>`／空白の内部 -> scored last (not excluded) so a boundary
 *      immediately before a `<br>` or whitespace filler is only chosen when
 *      truly nothing else qualifies (chooseBoundaries' `best === -1` guard
 *      still needs a full range of scored candidates); prevents splitting a
 *      blank-line run across two chunks so the next chunk never opens on a
 *      stray blank line.
 *
 * Spec tier "8. テキストノード境界" -> splitTextFallback below: only reached
 * when the content has fewer top-level/recursed segments than chunks needed;
 * splits a Text node at a Unicode code-point boundary (Array.from), never
 * inside an element, so <ruby> and HTML entities can never be broken
 * (entities do not exist at this stage — content is DOM text, re-escaped on
 * output).
 *
 * "巨大ブロックは子ノードへ再帰する" is implemented by flattenSegments:
 * before scoring, any single top-level child whose own text exceeds
 * DOMINANT_FRACTION of the total is expanded into ITS children in place
 * (recursively, capped at MAX_RECURSION_DEPTH) — this is also what supplies
 * enough segments when the content is naturally low in top-level children.
 */

const CHUNK_COUNT = 4;
const DOMINANT_FRACTION = 0.4;
const MAX_RECURSION_DEPTH = 6;
/** ±20% of the target position, per spec §14 "通常は目標位置±20%から選ぶ". */
const TARGET_BAND_FRACTION = 0.2;
/** 青空文庫リーダーHTMLに <span class="notes"> として残る改ページ注記。
 * TXT経路の parse-document.ts が認識する記法集合と同じもの。 */
const AOZORA_PAGE_BREAK_NOTE = /^［＃(改ページ|改丁|改見開き|改段)］$/;

export interface DomChunk extends ContentMetrics {
  html: string;
}

// Exported (with repairHeadingOrphans below) solely so the cascading-repair
// regression test can build a minimal fixture directly, without going
// through the full text-target-driven chooseBoundaries — the scenario that
// bug needs (several consecutive headings spanning more than one boundary)
// is awkward to coerce reliably out of chooseBoundaries' balancing
// heuristics, but trivial to hand-construct at the Segment level.
export interface Segment {
  /** Serialized HTML for this segment, safe to concatenate directly into a chunk. */
  html: string;
  /** Unicode code points, whitespace stripped. */
  textLen: number;
  isHeading: boolean;
  isBr: boolean;
  isBlock: boolean;
  isPageBreak: boolean;
  /** True when this is a text segment whose trailing content ends a sentence. */
  endsSentence: boolean;
}

function strippedLength(text: string): number {
  return Array.from(text.replace(/\s+/g, "")).length;
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Structural subset of linkedom's element/text node the algorithm needs. */
interface DomNode {
  nodeType: number;
  textContent: string | null;
  childNodes: DomNode[];
}
interface DomTextNode extends DomNode {
  data: string;
}
interface DomElement extends DomNode {
  tagName: string;
  outerHTML: string;
  getAttribute(name: string): string | null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function isTextNode(node: DomNode): node is DomTextNode {
  return node.nodeType === TEXT_NODE;
}
function isElementNode(node: DomNode): node is DomElement {
  return node.nodeType === ELEMENT_NODE;
}

/** Builds the ordered segment list for `node`'s children, recursing into any
 * dominant child (see the module doc comment). */
function flattenSegments(node: DomNode, totalLength: number, depth: number): Segment[] {
  const out: Segment[] = [];
  for (const child of node.childNodes) {
    if (isTextNode(child)) {
      const text = child.data;
      if (text.length === 0) {
        continue;
      }
      const len = strippedLength(text);
      if (len === 0) {
        // Whitespace-only text node: keep it attached to nothing on its own
        // (it carries no content weight) but still preserve it verbatim so
        // reassembly stays byte-for-byte over whitespace.
        out.push({
          html: escapeText(text),
          textLen: 0,
          isHeading: false,
          isBr: false,
          isBlock: false,
          isPageBreak: false,
          endsSentence: false,
        });
        continue;
      }
      out.push({
        html: escapeText(text),
        textLen: len,
        isHeading: false,
        isBr: false,
        isBlock: false,
        isPageBreak: false,
        endsSentence: /[。」』.!?]\s*$/.test(text.trimEnd()),
      });
      continue;
    }
    if (!isElementNode(child)) {
      continue; // comments etc. — never carry printable text
    }
    const tag = child.tagName.toLowerCase();
    const len = strippedLength(child.textContent ?? "");
    const dominant =
      depth < MAX_RECURSION_DEPTH &&
      totalLength > 0 &&
      len > totalLength * DOMINANT_FRACTION &&
      child.childNodes.length > 1;
    if (dominant) {
      out.push(...flattenSegments(child, totalLength, depth + 1));
      continue;
    }
    const classAttr = child.getAttribute("class") ?? "";
    out.push({
      html: child.outerHTML,
      textLen: len,
      isHeading: /^h[1-4]$/.test(tag),
      isBr: tag === "br",
      isBlock: tag === "div" || tag === "section",
      isPageBreak:
        tag === "hr" ||
        /page/i.test(classAttr) ||
        AOZORA_PAGE_BREAK_NOTE.test((child.textContent ?? "").trim()),
      endsSentence: false,
    });
  }
  return out;
}

/** 空白のみのセグメント（改行など）。textLen 0 かつ構造的な意味を持たない。 */
function isFiller(s: Segment): boolean {
  return (
    s.textLen === 0 && !s.isBr && !s.isBlock && !s.isHeading && !s.isPageBreak
  );
}

/** 境界 i の直前に連続する <br> の本数。空白のみのセグメントは数に入れず、
 * かつ連続を切らない（Aozora の reader HTML は <br>\r\n<br> と改行を挟む）。 */
function precedingBreakRun(segments: Segment[], i: number): number {
  let n = 0;
  for (let k = i - 1; k >= 0; k--) {
    const s = segments[k];
    if (s.isBr) {
      n++;
      continue;
    }
    if (isFiller(s)) continue;
    break;
  }
  return n;
}

/** 境界 i の直前にある、実体を持つ直近のセグメント（<br>・空白は飛ばす）。 */
function previousMeaningful(segments: Segment[], i: number): Segment | undefined {
  for (let k = i - 1; k >= 0; k--) {
    const s = segments[k];
    if (s.isBr || isFiller(s)) continue;
    return s;
  }
  return undefined;
}

/** Boundary "before segments[i]" priority score — lower wins (spec §14 order). */
function scoreBoundary(segments: Segment[], i: number): number {
  const next = segments[i];
  const prev = previousMeaningful(segments, i);
  const brRun = precedingBreakRun(segments, i);
  // 境界の直後が <br>／空白だと空行群が2チャンクに分断され、次チャンクの
  // 先頭ページが空行から始まる。実体のあるセグメントの直前にだけ置く。
  if (next.isBr || isFiller(next)) return 9;
  if (prev?.isPageBreak === true) return 1;
  if (next.isHeading) return 2;
  if (next.isBlock) return 3;
  if (brRun >= 2) return 4; // 空行 = 章・段落の切れ目
  if (brRun === 1 && prev?.endsSentence === true) return 5; // 行末かつ文末
  if (brRun === 1) return 6; // 行末
  if (prev?.isBlock === true) return 7;
  return 8; // 行の途中 — 最後の手段
}

/** Picks 3 boundary indices (each "before segments[boundary]") balancing
 * cumulative textLen toward 25/50/75%, preferring low-score candidates
 * within TARGET_BAND_FRACTION of the target, and never producing an empty
 * chunk. */
function chooseBoundaries(segments: Segment[]): number[] {
  const cumulative: number[] = [];
  let running = 0;
  for (const s of segments) {
    running += s.textLen;
    cumulative.push(running);
  }
  const totalLength = running;
  const targets = [0.25, 0.5, 0.75].map((f) => totalLength * f);
  const band = totalLength * TARGET_BAND_FRACTION;

  const chosen: number[] = [];
  let searchStart = 1;
  for (let t = 0; t < targets.length; t++) {
    const target = targets[t];
    // Leave at least one segment for every chunk still to come after this cut.
    const remainingChunksAfter = targets.length - t; // this one + later ones
    const maxIndex = segments.length - remainingChunksAfter;
    let best = -1;
    let bestScore = Infinity;
    let bestDist = Infinity;
    for (let i = searchStart; i <= maxIndex; i++) {
      const pos = cumulative[i - 1] ?? 0;
      const dist = Math.abs(pos - target);
      if (dist > band) continue;
      const score = scoreBoundary(segments, i);
      if (score < bestScore || (score === bestScore && dist < bestDist)) {
        best = i;
        bestScore = score;
        bestDist = dist;
      }
    }
    if (best === -1) {
      // Widen: nearest boundary to target regardless of the ±20% band.
      for (let i = searchStart; i <= maxIndex; i++) {
        const pos = cumulative[i - 1] ?? 0;
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
    }
    if (best === -1) {
      best = Math.max(searchStart, Math.min(maxIndex, searchStart));
    }
    chosen.push(best);
    searchStart = best + 1;
  }
  return chosen;
}

/** "見出しだけを前チャンクへ残さない" (§14): if a chosen cut would leave a
 * heading as the very last segment of the chunk before it, push the cut
 * earlier so the heading opens the NEXT chunk instead — never later, so this
 * can never collide with a later boundary. */
export function repairHeadingOrphans(segments: Segment[], boundaries: number[]): number[] {
  const repaired: number[] = [];
  // previousCut tracks the ALREADY-REPAIRED boundary immediately before the
  // one currently being adjusted (not the raw input array) — otherwise, when
  // several consecutive headings span more than one original boundary, the
  // lower bound for boundary[idx] would still be pinned to boundary[idx-1]'s
  // PRE-repair value, stopping the walk-back one segment too early instead
  // of letting it cascade across all of them.
  let previousCut = 0;
  for (const boundary of boundaries) {
    let cut = boundary;
    const lowerBound = previousCut + 1;
    while (cut > lowerBound && segments[cut - 1]?.isHeading === true) {
      cut -= 1;
    }
    repaired.push(cut);
    previousCut = cut;
  }
  return repaired;
}

function assembleChunks(segments: Segment[], boundaries: number[]): DomChunk[] {
  const cuts = [0, ...boundaries, segments.length];
  const chunks: DomChunk[] = [];
  for (let i = 0; i < CHUNK_COUNT; i++) {
    const slice = segments.slice(cuts[i], cuts[i + 1]);
    const html = slice.map((s) => s.html).join("");
    chunks.push({ html, ...computeFragmentMetrics(html) });
  }
  return chunks;
}

/** Splits `text` into `n` code-point-safe, non-empty pieces (spec §14 tier
 * 8, "テキストノード境界"). Used only when the content has fewer element/
 * text segments than CHUNK_COUNT after full recursive flattening — normal
 * Aozora chapters never reach this path (hundreds of ruby/br/text segments). */
function splitTextIntoPieces(text: string, n: number): string[] {
  const codePoints = Array.from(text);
  if (codePoints.length < n) {
    // Cannot produce n non-empty pieces from fewer code points than n —
    // caller must have already guaranteed enough text; guard defensively.
    throw new Error("the document could not be split safely");
  }
  const pieces: string[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const remaining = n - i;
    const take = Math.ceil((codePoints.length - start) / remaining);
    pieces.push(codePoints.slice(start, start + take).join(""));
    start += take;
  }
  return pieces;
}

/** Last-resort path when flattening (even at MAX_RECURSION_DEPTH) still
 * produced fewer than CHUNK_COUNT segments — expands the single largest
 * segment's raw text into CHUNK_COUNT (or "however many more are needed")
 * code-point-safe pieces. Only reachable on pathologically small/flat input
 * (e.g. a synthetic test fixture with 1-3 segments); real Aozora chapters
 * have far more natural boundaries. */
function forceEnoughSegments(segments: Segment[]): Segment[] {
  if (segments.length >= CHUNK_COUNT) {
    return segments;
  }
  const needed = CHUNK_COUNT - segments.length + 1;
  let largestIdx = -1;
  let largestLen = -1;
  segments.forEach((s, i) => {
    if (!s.isBr && s.textLen > largestLen) {
      largestLen = s.textLen;
      largestIdx = i;
    }
  });
  if (largestIdx === -1 || largestLen < needed) {
    throw new Error("the document could not be split safely");
  }
  const target = segments[largestIdx];
  // The segment's html IS its text for a text segment (escaped); for an
  // element segment there is no safe way to split inside it — only text
  // segments are ever picked here as long as one large enough exists.
  const rawText = target.html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const pieces = splitTextIntoPieces(rawText, needed);
  const replacement: Segment[] = pieces.map((piece) => ({
    html: escapeText(piece),
    textLen: strippedLength(piece),
    isHeading: false,
    isBr: false,
    isBlock: false,
    isPageBreak: false,
    endsSentence: /[。」』.!?]\s*$/.test(piece.trimEnd()),
  }));
  const out = [...segments];
  out.splice(largestIdx, 1, ...replacement);
  return forceEnoughSegments(out); // recurse in case still short
}

/**
 * Splits `contentHtml` (already-sanitized fragment — see the module doc
 * comment) into exactly CHUNK_COUNT ordered, non-empty pieces whose
 * concatenation reproduces the original content in DOM order with equal
 * text (spec §14's acceptance list). Throws a plain Error("the document
 * could not be split safely") — the fixed §19 message — on empty or
 * otherwise unsplittable content; callers should treat this as deterministic
 * (NonRetryableError).
 */
export function splitContentIntoChunks(contentHtml: string): DomChunk[] {
  const { document } = parseHTML(
    `<!doctype html><html><body>${contentHtml}</body></html>`,
  );
  const root = document.body as unknown as DomNode;
  const totalLength = strippedLength(root.textContent ?? "");
  if (totalLength === 0) {
    throw new Error("the document could not be split safely");
  }

  let segments = flattenSegments(root, totalLength, 0);
  segments = forceEnoughSegments(segments);

  const rawBoundaries = chooseBoundaries(segments);
  const boundaries = repairHeadingOrphans(segments, rawBoundaries);
  const chunks = assembleChunks(segments, boundaries);

  if (chunks.some((c) => c.textLength === 0)) {
    // Should be unreachable given forceEnoughSegments/chooseBoundaries'
    // remainingChunksAfter guard, but a chunk with zero content would
    // violate the spec's "空チャンクを作らない" requirement outright — fail
    // loudly (deterministic) rather than silently ship a blank page.
    throw new Error("the document could not be split safely");
  }
  return chunks;
}
