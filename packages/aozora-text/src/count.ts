// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { AozoraBlock, AozoraDocument, AozoraInline } from "./types";

/**
 * Counts recognized Aozora Bunko annotations/constructs in a parsed document
 * (spec §13.3's "認識注記件数" observability metric — src/text-prepare.ts's
 * PreparedTextDocument.diagnostics.recognizedAnnotations).
 *
 * Counted (spec §9): inline ruby/emphasis/decoration/tcy/gaiji, block
 * heading/pageBreak, and a paragraph whose `indentEm` or `align` is defined
 * (字下げ/地付き/中央寄せ recognition). Every count is per-node — a
 * decoration wrapping a ruby counts as 2, not 1 — and traversal recurses
 * into every nested `children`/`base` array.
 *
 * NOT counted: plain `text` nodes, `rawAnnotation` (inline or block — those
 * are tallied separately as unsupported/malformed, see
 * src/text-prepare.ts's prepareAozora), and an undecorated paragraph
 * (indentEm and align both undefined).
 */
export function countRecognizedAnnotations(document: AozoraDocument): number {
  return countBlocks(document.blocks) + countBlocks(document.bibliography);
}

function countBlocks(blocks: AozoraBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        if (block.indentEm !== undefined || block.align !== undefined) {
          count += 1;
        }
        count += countInline(block.children);
        break;
      case "heading":
        count += 1;
        count += countInline(block.children);
        break;
      case "pageBreak":
        count += 1;
        break;
      case "rawAnnotation":
        break;
    }
  }
  return count;
}

function countInline(nodes: AozoraInline[]): number {
  let count = 0;
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "rawAnnotation":
        break;
      case "ruby":
        count += 1;
        count += countInline(node.base);
        break;
      case "emphasis":
      case "decoration":
      case "tcy":
        count += 1;
        count += countInline(node.children);
        break;
      case "gaiji":
        count += 1;
        break;
    }
  }
  return count;
}
