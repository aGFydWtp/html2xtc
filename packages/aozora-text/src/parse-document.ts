// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { separateDocumentStructure } from "./metadata";
import { parseInlineText } from "./parse-inline";
import { splitIntoParagraphChunks } from "./tokenize";
import type { AozoraBlock, AozoraDiagnostic, AozoraDocument, AozoraInline } from "./types";
import { MAX_AST_NODES, MAX_DIAGNOSTICS, MAX_RANGE_NESTING_DEPTH } from "./types";

/**
 * Block-structure parser (spec §9.2, §9.3, §9.6, §9.7, §9.8; §10.2's
 * normalization order — this function receives text that has already been
 * through line-ending unification / control-char stripping / NFC, and does
 * NOT itself collapse blank lines or join hard-wrapped lines before
 * parsing).
 *
 * Split of responsibility with parse-inline.ts: this file recognizes
 * constructs that change a *block's* shape or that persist *across*
 * paragraphs — 改ページ, 見出し, 字下げ/中央寄せ (both the one-shot and the
 * ここから…ここで…終わり range forms) — by looking at whole paragraph
 * chunks (spec §10.2 chunks: runs of 2+ newlines). Constructs that only
 * ever affect a run of *inline* content within one paragraph (ルビ, 傍点,
 * 傍線/太字/斜体, 縦中横, 外字) are parse-inline.ts's job.
 *
 * Two different recognition strategies are used for "is this content a
 * block directive, not body text", matched to how real Aozora documents
 * actually place these annotations:
 *
 * - 改ページ / 字下げ / 中央寄せ (one-shot and range markers) and the
 *   same-line 見出し form are always written alone on their own source
 *   line (spec §9's examples) — but real documents don't reliably separate
 *   that line from its neighbors with a *blank* line too (that was this
 *   file's original, buggy assumption: testing "the whole blank-line-run
 *   chunk equals exactly one control annotation" instead of "some *line*
 *   within the chunk does" silently downgraded these annotations to
 *   literal text whenever the surrounding prose had no blank lines at
 *   all). So paragraph chunks (still split on blank-line runs, unchanged)
 *   are further split into physical lines here, and any line that is
 *   *alone on its line* (trimmed, matches a control annotation exactly)
 *   becomes its own directive; consecutive non-matching lines are glued
 *   back into one paragraph, byte-for-byte identical to the pre-fix
 *   behavior when no such line exists in a chunk at all.
 * - 見出しレンジ (ここから…見出し／ここで…見出し終わり) is different: real
 *   Aozora usage also writes the whole range on a single line with the
 *   heading's own text sandwiched between the two markers (spec §9.3's
 *   example), so it cannot be recognized by "alone on its line" — nor
 *   should it require being chunk-bounded at all, since a valid range must
 *   be honored however many paragraph chunks or physical lines separate
 *   its ここから from its ここで. It is instead found by directly scanning
 *   the region's raw text once (`splitByHeadingRanges`, an O(n) two-marker
 *   state machine, spec §17) *before* any paragraph/line splitting runs,
 *   producing an alternating list of "ordinary text" and "recognized
 *   heading" segments; only the "ordinary text" segments then go through
 *   the paragraph/line/control-annotation pipeline above.
 */

/** Thrown when the document would exceed MAX_AST_NODES (spec §17's "AST
 *全体上限超過は決定的エラー" — deterministic failure, not a truncated
 * partial document). Message deliberately holds no document content. */
export class AozoraAstLimitExceededError extends Error {
  constructor() {
    super(`aozora document exceeds the ${MAX_AST_NODES}-node AST limit`);
    this.name = "AozoraAstLimitExceededError";
  }
}

// --- Heading recognition (spec §9.3) ---------------------------------

type HeadingLevel = 1 | 2 | 3;
type HeadingVariant = "normal" | "inline" | "window";

const HEADING_LEVEL_BY_WORD: Record<string, HeadingLevel> = { "大": 1, "中": 2, "小": 3 };
const HEADING_LABEL_RE = /^(同行|窓)?(大|中|小)見出し$/;

function parseHeadingLabel(label: string): { level: HeadingLevel; variant: HeadingVariant } | undefined {
  const m = HEADING_LABEL_RE.exec(label);
  if (!m) return undefined;
  const variant = m[1] === "同行" ? "inline" : m[1] === "窓" ? "window" : "normal";
  return { level: HEADING_LEVEL_BY_WORD[m[2]], variant };
}

/** Reconstructs the label text (e.g. "同行大見出し") from a level/variant
 * pair — used only for diagnostics where there's no captured annotation
 * text to quote verbatim (e.g. a range that never closed). */
function headingLabelText(level: HeadingLevel, variant: HeadingVariant): string {
  const levelWord = level === 1 ? "大" : level === 2 ? "中" : "小";
  const variantPrefix = variant === "inline" ? "同行" : variant === "window" ? "窓" : "";
  return `${variantPrefix}${levelWord}見出し`;
}

const HEADING_SAME_LINE_RE = /^([\s\S]*)［＃「([^」]*)」は((?:同行|窓)?(?:大|中|小)見出し)］$/;
const HEADING_RANGE_START_BODY_RE = /^ここから((?:同行|窓)?(?:大|中|小)見出し)$/;
const HEADING_RANGE_END_BODY_RE = /^ここで((?:同行|窓)?(?:大|中|小)見出し)終わり$/;
/** Whole-line form of the end marker, for recognizing a *lone* (no
 * matching open range anywhere in the document) end marker as its own
 * fail-soft block: pushed as a standalone visible `rawAnnotation` block with
 * an "unmatched-end" diagnostic, same as 字下げ/中央寄せ's own lone-end-marker
 * handling (spec §9.6/§9.7/§18.3, `pushRawAnnotationBlock` below). This is
 * deliberately *not* what happens to an end marker found while a heading
 * range *is* open but doesn't match it (spec §18.3's other mismatch shape,
 * handled inside `splitByHeadingRanges` instead): that case only pushes the
 * diagnostic and folds the marker's raw text into the still-open range's
 * content — it never becomes its own block — because unlike 字下げ/中央寄せ
 * (which tag otherwise-independent paragraphs one at a time), an open
 * heading range hasn't decided where its own content ends yet, so there is
 * no already-emitted block to interrupt. Every *matched* range's markers are
 * instead consumed by `splitByHeadingRanges` before this ever runs. */
const HEADING_RANGE_END_LINE_RE = /^［＃ここで((?:同行|窓)?(?:大|中|小)見出し)終わり］$/;

interface HeadingSegment {
  kind: "heading";
  text: string;
  startLine: number;
  level: HeadingLevel;
  variant: HeadingVariant;
}
interface OutsideSegment {
  kind: "outside";
  text: string;
  startLine: number;
}
type TextSegment = HeadingSegment | OutsideSegment;

/**
 * Scans one region's raw text once (spec §17's O(n) requirement — see the
 * complexity note below) for 見出しレンジ (ここから…見出し／ここで…見出し
 * 終わり) pairs, splitting it into alternating "heading" and "outside"
 * segments. A start marker always opens a range (there is nothing to
 * disambiguate — spec §9.3 has no other meaning for ここから＋見出し); an
 * end marker only closes it if the level/variant match (mismatches fail
 * soft into the still-open range's own content, spec §18.3, diagnosed as
 * "unmatched-end" the same way 字下げ/中央寄せ range mismatches already
 * are). A range still open at the end of the region is diagnosed as
 * "unclosed-range" and its start marker plus everything after it is
 * handed back as ordinary text (fail soft — spec §4.3 never drops text),
 * which lets the normal paragraph/annotation pipeline recognize whatever
 * turns out to be inside it instead of silently losing it.
 *
 * Complexity: `pos` is strictly non-decreasing and every `indexOf` scan
 * (for "［＃" and for the matching "］") starts at or after the previous
 * one's result, so — exactly as tokenize.ts's module doc argues for its
 * own scan — the total work across every `indexOf` and per-annotation
 * regex test in this function is bounded by the input length once.
 */
/** True iff `text[from]` (an already-known-non-newline character) is
 * whitespace other than "\n" — used only by `isAloneOnOwnLine` below, where
 * "\n" must be treated as its own, separate terminator rather than as just
 * more whitespace to skip past. */
function isBlankNonNewline(ch: string): boolean {
  return ch !== "\n" && /\s/.test(ch);
}

/**
 * Whole-line, no-other-content-on-the-line test for the `［＃...］` span
 * `text[bracketIdx, closeIdx]`, mirroring `looksLikeControlLine`'s
 * "alone on its line" rule but operating on raw offsets instead of an
 * already-line-split string (this runs *before* any line splitting, inside
 * `splitByHeadingRanges`'s single forward scan).
 *
 * Complexity: each direction stops at the first "\n" *or* the first
 * non-whitespace character, whichever comes first — never searches past
 * that unconditionally for "\n" alone (which is what would make repeated
 * calls, one per annotation on a very long line, quadratic: identical to
 * the exact failure mode this function exists to avoid one level up). Two
 * annotations' scans can therefore only ever both cover the same stretch of
 * whitespace once each (one scanning forward from the earlier annotation,
 * one scanning backward from the later one) — a constant-factor overlap,
 * not a repeated one — so the total work across every call in one
 * `splitByHeadingRanges` pass stays bounded by the input length.
 */
function isAloneOnOwnLine(text: string, bracketIdx: number, closeIdx: number): boolean {
  let i = bracketIdx - 1;
  while (i >= 0 && isBlankNonNewline(text[i])) i--;
  if (i >= 0 && text[i] !== "\n") return false;

  const n = text.length;
  let j = closeIdx + 1;
  while (j < n && isBlankNonNewline(text[j])) j++;
  return j >= n || text[j] === "\n";
}

function splitByHeadingRanges(text: string, ctx: DocumentParseContext): TextSegment[] {
  const segments: TextSegment[] = [];
  const n = text.length;
  let pos = 0;
  let line = 1;
  let outsideStart = 0;
  let outsideStartLine = 1;
  let open: { level: HeadingLevel; variant: HeadingVariant; startLine: number; markerStart: number; contentStart: number } | undefined;

  function newlinesBetween(from: number, to: number): number {
    let count = 0;
    for (let k = from; k < to; k++) {
      if (text.charCodeAt(k) === 10) count++;
    }
    return count;
  }

  while (pos < n) {
    const bracketIdx = text.indexOf("［＃", pos);
    if (bracketIdx === -1) break;
    const closeIdx = text.indexOf("］", bracketIdx + 2);
    if (closeIdx === -1) break;
    const body = text.slice(bracketIdx + 2, closeIdx);
    const lineAtBracket = line + newlinesBetween(pos, bracketIdx);

    if (!open) {
      const m = HEADING_RANGE_START_BODY_RE.exec(body);
      const info = m ? parseHeadingLabel(m[1]) : undefined;
      if (m && info) {
        if (bracketIdx > outsideStart) {
          segments.push({ kind: "outside", text: text.slice(outsideStart, bracketIdx), startLine: outsideStartLine });
        }
        open = { level: info.level, variant: info.variant, startLine: lineAtBracket, markerStart: bracketIdx, contentStart: closeIdx + 1 };
        pos = closeIdx + 1;
        line = lineAtBracket + newlinesBetween(bracketIdx, pos);
        continue;
      }
    } else {
      const m = HEADING_RANGE_END_BODY_RE.exec(body);
      if (m) {
        const endInfo = parseHeadingLabel(m[1]);
        if (endInfo && endInfo.level === open.level && endInfo.variant === open.variant) {
          segments.push({
            kind: "heading",
            text: text.slice(open.contentStart, bracketIdx),
            startLine: open.startLine,
            level: open.level,
            variant: open.variant,
          });
          pos = closeIdx + 1;
          line = lineAtBracket + newlinesBetween(bracketIdx, pos);
          outsideStart = pos;
          outsideStartLine = line;
          open = undefined;
          continue;
        }
        // Mismatched level/variant while a range is open: fail soft by
        // folding this marker's raw text into the still-open range's
        // content (it stays exactly where it was in the source, so it
        // simply becomes literal inline text once the range does close) —
        // never closes the open range itself.
        ctx.pushDiagnostic("unmatched-end", lineAtBracket, `${m[1]}終わり`);
        pos = closeIdx + 1;
        line = lineAtBracket + newlinesBetween(bracketIdx, pos);
        continue;
      }

      // A 改ページ／字下げ／地付き／中央寄せ control annotation, alone on
      // its own line, found *while still inside* an open heading range: a
      // real 見出しレンジ only ever wraps a few words of title text (spec
      // §9.3), so seeing a page/indent/align switch here means the ここで
      // …見出し終わり was missed somewhere, not that this control line is
      // legitimately part of the heading. Without this check, the range
      // would swallow everything up to whatever distant/unrelated ここで
      // marker happens to match next (or EOF), silently reverting exactly
      // the bug this file was fixed for: 改ページ etc. downgraded to inert
      // text with no block and no diagnostic. Bail out the same way an
      // unclosed range already does — diagnose it and hand the range's
      // start marker onward as ordinary text — but scoped to "up to this
      // control line" instead of "up to EOF", so the control line itself
      // (and everything after) still goes through the normal pipeline and
      // gets interpreted correctly. `pos`/`line` are deliberately left
      // untouched so the very next loop iteration re-examines this same
      // "［＃" span with `open` now cleared.
      //
      // A blank-line run is deliberately *not* also a truncation trigger:
      // real 見出しレンジ usage occasionally wraps a couple of短い lines
      // with incidental blank lines around them (spec §9.3 doesn't forbid
      // it), and the whole point of scanning here instead of chunk-by-chunk
      // is to still honor a range that spans them. The residual risk this
      // leaves — a stray, never-closed ここから…見出し pairing with some
      // unrelated, later ここで…見出し終わり across nothing but blank lines
      // and prose — has no bound tighter than "next control annotation or
      // EOF" without also re-introducing the chunk-boundary blindness this
      // rewrite exists to remove; that trade-off is accepted here.
      if (isAloneOnOwnLine(text, bracketIdx, closeIdx) && looksLikeControlLine(text.slice(bracketIdx, closeIdx + 1))) {
        ctx.pushDiagnostic("unclosed-range", 0, headingLabelText(open.level, open.variant));
        outsideStart = open.markerStart;
        outsideStartLine = open.startLine;
        open = undefined;
        continue;
      }
    }

    pos = closeIdx + 1;
    line = lineAtBracket + newlinesBetween(bracketIdx, pos);
  }

  if (open) {
    ctx.pushDiagnostic("unclosed-range", 0, headingLabelText(open.level, open.variant));
    segments.push({ kind: "outside", text: text.slice(open.markerStart, n), startLine: open.startLine });
  } else if (n > outsideStart) {
    segments.push({ kind: "outside", text: text.slice(outsideStart, n), startLine: outsideStartLine });
  }

  return segments;
}

// --- Control-chunk recognition (spec §9.2, §9.6, §9.7, §9.8) --------

const PAGE_BREAK_KIND: Record<string, "page" | "sheet" | "spread" | "column"> = {
  "改ページ": "page",
  "改丁": "sheet",
  "改見開き": "spread",
  "改段": "column",
};
const PAGE_BREAK_RE = /^［＃(改ページ|改丁|改見開き|改段)］$/;
const INDENT_SINGLE_RE = /^［＃(\d+)字下げ］$/;
const INDENT_RANGE_START_RE = /^［＃ここから(\d+)字下げ］$/;
const INDENT_RANGE_END_RE = /^［＃ここで字下げ終わり］$/;
const CHITSUKI_RE = /^［＃地付き］$/;
const AGARI_RE = /^［＃地から(\d+)字上げ］$/;
const CENTER_SINGLE_RE = /^［＃中央寄せ］$/;
const CENTER_RANGE_START_RE = /^［＃ここから中央寄せ］$/;
const CENTER_RANGE_END_RE = /^［＃ここで中央寄せ終わり］$/;

/** Whole-line, no-other-content-on-the-line test for whether `trimmed`
 * (already a single physical line) is one of the 9 non-heading control
 * annotations — used only to decide whether to flush the buffered plain
 * lines *before* calling `handleControlChunk` (spec: a control line must
 * never be glued into the paragraph that precedes it). `handleControlChunk`
 * re-tests each pattern itself; this is deliberately a cheap OR of the same
 * regexes; it does no mutation. */
function looksLikeControlLine(trimmed: string): boolean {
  return (
    PAGE_BREAK_RE.test(trimmed) ||
    INDENT_SINGLE_RE.test(trimmed) ||
    INDENT_RANGE_START_RE.test(trimmed) ||
    INDENT_RANGE_END_RE.test(trimmed) ||
    CHITSUKI_RE.test(trimmed) ||
    AGARI_RE.test(trimmed) ||
    CENTER_SINGLE_RE.test(trimmed) ||
    CENTER_RANGE_START_RE.test(trimmed) ||
    CENTER_RANGE_END_RE.test(trimmed)
  );
}

const MAX_INDENT_EM = 30;

type BlockRangeFrame = { kind: "indent"; em: number } | { kind: "align"; value: "center" };
interface PendingOneShot {
  indentEm?: number;
  align?: "center" | "end";
}

function countInlineNodes(children: AozoraInline[]): number {
  let count = 0;
  for (const node of children) {
    count += 1;
    if (node.type === "ruby") count += countInlineNodes(node.base);
    else if (node.type === "emphasis" || node.type === "decoration" || node.type === "tcy") {
      count += countInlineNodes(node.children);
    }
  }
  return count;
}

function countBlockNodes(block: AozoraBlock): number {
  if (block.type === "paragraph" || block.type === "heading") {
    return 1 + countInlineNodes(block.children);
  }
  return 1;
}

interface DocumentParseContext {
  pushDiagnostic: (kind: AozoraDiagnostic["kind"], line: number, annotationName?: string) => void;
  addNodes: (count: number) => void;
}

function truncateLabel(value: string): string {
  const chars = Array.from(value);
  return chars.length > 64 ? chars.slice(0, 64).join("") + "…" : value;
}

/**
 * Parses one region's worth of already-line-split body text (the main body,
 * or the 底本 bibliography — each gets its own independent block-range
 * state, spec §17's "後方参照は現在段落内のみ" extended here to "block
 * ranges never span the body/bibliography boundary") into blocks.
 */
function parseBlocks(bodyText: string, ctx: DocumentParseContext): AozoraBlock[] {
  const blocks: AozoraBlock[] = [];
  const rangeStack: BlockRangeFrame[] = [];
  let pending: PendingOneShot = {};

  function currentIndentEm(): number | undefined {
    if (pending.indentEm !== undefined) return pending.indentEm;
    for (let i = rangeStack.length - 1; i >= 0; i--) {
      const frame = rangeStack[i];
      if (frame.kind === "indent") return frame.em;
    }
    return undefined;
  }

  function currentAlign(): "center" | "end" | undefined {
    if (pending.align !== undefined) return pending.align;
    for (let i = rangeStack.length - 1; i >= 0; i--) {
      if (rangeStack[i].kind === "align") return "center";
    }
    return undefined;
  }

  function pushRawAnnotationBlock(text: string): void {
    const block: AozoraBlock = { type: "rawAnnotation", text };
    ctx.addNodes(countBlockNodes(block));
    blocks.push(block);
  }

  // --- Buffer for consecutive non-control physical lines within the
  // *current* paragraph chunk — grouped into a single paragraph. Reset per
  // chunk (plain content never glues across a blank-line-run boundary). A
  // chunk with no control line at all round-trips through this buffer
  // byte-for-byte (split then rejoined on "\n"), so this is a no-op for
  // every chunk shape the pre-fix parser already handled correctly. -------
  let buffer: string[] = [];
  let bufferStartLine = 0;

  function pushToBuffer(text: string, lineNo: number): void {
    if (buffer.length === 0) bufferStartLine = lineNo;
    buffer.push(text);
  }

  function flushBuffer(): void {
    if (buffer.length === 0) return;
    const joined = buffer.join("\n");
    buffer = [];
    // Whitespace-only is a boundary artifact, not body content — e.g. the
    // blank line left over immediately after slicing a heading/control
    // marker out of the middle of an "outside" segment (spec §10.2's
    // existing "blank chunks are boundaries only" rule, applied here too).
    if (joined.trim().length === 0) return;
    const block = buildParagraph(joined, bufferStartLine);
    ctx.addNodes(countBlockNodes(block));
    blocks.push(block);
  }

  function handleControlChunk(trimmed: string, startLine: number): boolean {
    const pageBreak = PAGE_BREAK_RE.exec(trimmed);
    if (pageBreak) {
      const block: AozoraBlock = { type: "pageBreak", kind: PAGE_BREAK_KIND[pageBreak[1]] };
      ctx.addNodes(countBlockNodes(block));
      blocks.push(block);
      return true;
    }

    const indentSingle = INDENT_SINGLE_RE.exec(trimmed);
    if (indentSingle) {
      const em = Number(indentSingle[1]);
      if (em <= MAX_INDENT_EM) {
        pending = { ...pending, indentEm: em };
      } else {
        pushRawAnnotationBlock(trimmed);
        ctx.pushDiagnostic("unsupported-annotation", startLine, `${em}字下げ`);
      }
      return true;
    }

    const indentStart = INDENT_RANGE_START_RE.exec(trimmed);
    if (indentStart) {
      const em = Number(indentStart[1]);
      if (em > MAX_INDENT_EM) {
        pushRawAnnotationBlock(trimmed);
        ctx.pushDiagnostic("unsupported-annotation", startLine, `ここから${em}字下げ`);
      } else if (rangeStack.length >= MAX_RANGE_NESTING_DEPTH) {
        pushRawAnnotationBlock(trimmed);
        ctx.pushDiagnostic("resource-limit", startLine, "字下げ");
      } else {
        rangeStack.push({ kind: "indent", em });
      }
      return true;
    }

    if (INDENT_RANGE_END_RE.test(trimmed)) {
      const topIdx = rangeStack.length - 1;
      if (topIdx >= 0 && rangeStack[topIdx].kind === "indent") {
        rangeStack.pop();
      } else {
        pushRawAnnotationBlock(trimmed);
        ctx.pushDiagnostic("unmatched-end", startLine, "字下げ終わり");
      }
      return true;
    }

    if (CHITSUKI_RE.test(trimmed)) {
      pending = { ...pending, align: "end", indentEm: undefined };
      return true;
    }

    const agari = AGARI_RE.exec(trimmed);
    if (agari) {
      const em = Number(agari[1]);
      if (em <= MAX_INDENT_EM) {
        pending = { ...pending, align: "end", indentEm: em };
      } else {
        pushRawAnnotationBlock(trimmed);
        ctx.pushDiagnostic("unsupported-annotation", startLine, `地から${em}字上げ`);
      }
      return true;
    }

    if (CENTER_SINGLE_RE.test(trimmed)) {
      pending = { ...pending, align: "center" };
      return true;
    }

    if (CENTER_RANGE_START_RE.test(trimmed)) {
      if (rangeStack.length >= MAX_RANGE_NESTING_DEPTH) {
        pushRawAnnotationBlock(trimmed);
        ctx.pushDiagnostic("resource-limit", startLine, "中央寄せ");
      } else {
        rangeStack.push({ kind: "align", value: "center" });
      }
      return true;
    }

    if (CENTER_RANGE_END_RE.test(trimmed)) {
      const topIdx = rangeStack.length - 1;
      if (topIdx >= 0 && rangeStack[topIdx].kind === "align") {
        rangeStack.pop();
      } else {
        pushRawAnnotationBlock(trimmed);
        ctx.pushDiagnostic("unmatched-end", startLine, "中央寄せ終わり");
      }
      return true;
    }

    return false;
  }

  function buildParagraph(chunk: string, startLine: number): AozoraBlock {
    const indentEm = currentIndentEm();
    const align = currentAlign();
    pending = {};
    const children = parseInlineText(chunk, {
      line: startLine,
      pushDiagnostic: (d) => ctx.pushDiagnostic(d.kind, d.line, d.annotationName),
    });
    const block: AozoraBlock = {
      type: "paragraph",
      children,
      ...(indentEm !== undefined ? { indentEm } : {}),
      ...(align !== undefined ? { align } : {}),
    };
    return block;
  }

  /** Same-line 見出し form: `X［＃「X」は…見出し］`, the whole physical
   * line, nothing else (spec §9.3's example always has the annotation
   * describe its entire line). A structural match whose quoted target
   * doesn't equal the preceding text on that line isn't really a same-line
   * heading marker — the caller falls through to ordinary paragraph
   * handling, where parse-inline.ts's own quoted-target lookup fails the
   * same way and fails soft. */
  function matchSameLineHeading(trimmedLine: string): { level: HeadingLevel; variant: HeadingVariant; before: string } | undefined {
    const m = HEADING_SAME_LINE_RE.exec(trimmedLine);
    if (!m) return undefined;
    const [, before, target, label] = m;
    const info = parseHeadingLabel(label);
    if (!info) return undefined;
    if (before.trim() !== target.trim()) return undefined;
    return { level: info.level, variant: info.variant, before };
  }

  function parseOutsideSegment(segment: OutsideSegment): void {
    for (const { text: chunkText, startLine: relLine } of splitIntoParagraphChunks(segment.text)) {
      if (chunkText.trim().length === 0) continue;
      const chunkStartLine = segment.startLine - 1 + relLine;

      const lines = chunkText.split("\n");
      buffer = [];
      for (let li = 0; li < lines.length; li++) {
        const lineText = lines[li];
        const lineNo = chunkStartLine + li;
        const trimmed = lineText.trim();

        if (looksLikeControlLine(trimmed)) {
          flushBuffer();
          handleControlChunk(trimmed, lineNo);
          continue;
        }

        if (HEADING_RANGE_END_LINE_RE.test(trimmed)) {
          // A lone end marker with no matching open range anywhere in the
          // document (any marker that *did* pair up, or that fell inside
          // a still-open range, was already consumed by
          // splitByHeadingRanges before this ever runs) — fails soft the
          // same way 字下げ/中央寄せ's own unmatched-end does.
          flushBuffer();
          const m = HEADING_RANGE_END_LINE_RE.exec(trimmed)!;
          pushRawAnnotationBlock(trimmed);
          ctx.pushDiagnostic("unmatched-end", lineNo, `${m[1]}終わり`);
          continue;
        }

        const sameLine = matchSameLineHeading(trimmed);
        if (sameLine) {
          flushBuffer();
          const children = parseInlineText(sameLine.before, {
            line: lineNo,
            pushDiagnostic: (d) => ctx.pushDiagnostic(d.kind, d.line, d.annotationName),
          });
          const block: AozoraBlock = { type: "heading", level: sameLine.level, variant: sameLine.variant, children };
          ctx.addNodes(countBlockNodes(block));
          blocks.push(block);
          continue;
        }

        pushToBuffer(lineText, lineNo);
      }
      flushBuffer();
    }
  }

  for (const segment of splitByHeadingRanges(bodyText, ctx)) {
    if (segment.kind === "heading") {
      const children = parseInlineText(segment.text, {
        line: segment.startLine,
        pushDiagnostic: (d) => ctx.pushDiagnostic(d.kind, d.line, d.annotationName),
      });
      const block: AozoraBlock = { type: "heading", level: segment.level, variant: segment.variant, children };
      ctx.addNodes(countBlockNodes(block));
      blocks.push(block);
      continue;
    }
    parseOutsideSegment(segment);
  }

  // Range annotations still open at the end of this region (spec §17's
  // scope restriction applied to block ranges too): fail soft — the
  // remaining content already emitted keeps whatever indent/align it had,
  // just diagnose that the range was never closed.
  for (let i = 0; i < rangeStack.length; i++) {
    ctx.pushDiagnostic("unclosed-range", 0, rangeStack[i].kind === "indent" ? "字下げ" : "中央寄せ");
  }

  return blocks;
}

export function parseAozoraDocument(text: string): AozoraDocument {
  const lines = text.split("\n");
  const structure = separateDocumentStructure(lines);

  const diagnostics: AozoraDiagnostic[] = [];
  let nodeCount = 0;

  const ctx: DocumentParseContext = {
    pushDiagnostic(kind, line, annotationName) {
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        diagnostics.push({
          kind,
          severity: kind === "resource-limit" ? "error" : "warning",
          line,
          column: 0,
          ...(annotationName !== undefined ? { annotationName: truncateLabel(annotationName) } : {}),
        });
      }
    },
    addNodes(count) {
      if (nodeCount + count > MAX_AST_NODES) {
        throw new AozoraAstLimitExceededError();
      }
      nodeCount += count;
    },
  };

  const blocks = parseBlocks(structure.bodyLines.join("\n"), ctx);
  const bibliography = parseBlocks(structure.bibliographyLines.join("\n"), ctx);

  return {
    title: structure.title,
    author: structure.author,
    blocks,
    bibliography,
    diagnostics,
  };
}
