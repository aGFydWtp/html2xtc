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
 * A 字下げ/中央寄せ *range* is treated as spanning every paragraph chunk
 * between its ここから/ここで markers, however many chunks that is — real
 * Aozora usage always puts these control annotations alone on their own
 * line, so "this chunk's trimmed text is exactly one recognized control
 * annotation" is a reliable, simple test for "this chunk is a directive,
 * not body content" that doesn't require look-ahead or backtracking.
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

const HEADING_LEVEL_BY_WORD: Record<string, 1 | 2 | 3> = { "大": 1, "中": 2, "小": 3 };
const HEADING_LABEL_RE = /^(同行|窓)?(大|中|小)見出し$/;

function parseHeadingLabel(label: string): { level: 1 | 2 | 3; variant: "normal" | "inline" | "window" } | undefined {
  const m = HEADING_LABEL_RE.exec(label);
  if (!m) return undefined;
  const variant = m[1] === "同行" ? "inline" : m[1] === "窓" ? "window" : "normal";
  return { level: HEADING_LEVEL_BY_WORD[m[2]], variant };
}

const HEADING_SAME_LINE_RE = /^([\s\S]*)［＃「([^」]*)」は((?:同行|窓)?(?:大|中|小)見出し)］$/;
const HEADING_RANGE_RE =
  /^［＃ここから((?:同行|窓)?(?:大|中|小)見出し)］([\s\S]*)［＃ここで((?:同行|窓)?(?:大|中|小)見出し)終わり］$/;

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

  function tryHeading(chunk: string, startLine: number): AozoraBlock | undefined {
    const rangeMatch = HEADING_RANGE_RE.exec(chunk.trim());
    if (rangeMatch) {
      const [, startLabel, inner, endLabel] = rangeMatch;
      const startInfo = parseHeadingLabel(startLabel);
      const endInfo = parseHeadingLabel(endLabel);
      if (startInfo && endInfo && startInfo.level === endInfo.level && startInfo.variant === endInfo.variant) {
        const children = parseInlineText(inner, {
          line: startLine,
          pushDiagnostic: (d) => ctx.pushDiagnostic(d.kind, d.line, d.annotationName),
        });
        return { type: "heading", level: startInfo.level, variant: startInfo.variant, children };
      }
    }

    const sameLine = HEADING_SAME_LINE_RE.exec(chunk.trim());
    if (sameLine) {
      const [, before, target, label] = sameLine;
      const info = parseHeadingLabel(label);
      // The quoted target must match the whole preceding line (spec §9.3's
      // example always has the annotation describe its entire line) — a
      // mismatch means this isn't really a same-line heading marker, so
      // fall through to ordinary paragraph parsing (where parse-inline.ts's
      // own quoted-target lookup will fail the same way and fail soft).
      if (info && before.trim() === target.trim()) {
        const children = parseInlineText(before, {
          line: startLine,
          pushDiagnostic: (d) => ctx.pushDiagnostic(d.kind, d.line, d.annotationName),
        });
        return { type: "heading", level: info.level, variant: info.variant, children };
      }
    }

    return undefined;
  }

  for (const { text: chunk, startLine } of splitIntoParagraphChunks(bodyText)) {
    // Whitespace-only chunks are paragraph *boundaries* only — a design
    // choice, not an oversight: blank runs already delimit <p> elements at
    // render time (render-html.ts joins blocks with "\n", no visible blank
    // line survives between them either way), so there is no visual blank
    // line left for options.maxConsecutiveBlankLines (spec §10.2's "AST上で
    // 空行上限を適用") to collapse. This AST intentionally never gets a
    // blank-line AST node, and this parser does not apply
    // maxConsecutiveBlankLines to the aozora path at all.
    if (chunk.trim().length === 0) continue;

    const trimmed = chunk.trim();
    if (handleControlChunk(trimmed, startLine)) continue;

    const heading = tryHeading(chunk, startLine);
    const block = heading ?? buildParagraph(chunk, startLine);
    ctx.addNodes(countBlockNodes(block));
    blocks.push(block);
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
