// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { tokenizeAozoraChunk } from "./tokenize";
import type { AozoraDiagnostic, AozoraInline } from "./types";
import {
  MAX_ANNOTATION_CODEPOINTS,
  MAX_RANGE_NESTING_DEPTH,
  MAX_RUBY_READING_CODEPOINTS,
} from "./types";

/**
 * Inline structure parser for one paragraph chunk (spec §9.1, §9.4, §9.5,
 * §9.9, §9.10; "現在段落内のみ後方参照" — every backward-reference this
 * file performs — implicit ruby base lookback, 傍点/傍線/太字/斜体/縦中横
 * post-form target lookback, range-annotation nesting — is scoped to the
 * single chunk string passed in, never anything outside it. Block-level
 * constructs (見出し, 改ページ, 字下げ, 地付き, 中央寄せ) are
 * parse-document.ts's responsibility; this file only ever returns
 * `AozoraInline[]`, never a block.
 */

type EmphasisStyle = Extract<AozoraInline, { type: "emphasis" }>["style"];
type DecorationStyle = Extract<AozoraInline, { type: "decoration" }>["style"];

const EMPHASIS_LABELS: Record<string, EmphasisStyle> = {
  "傍点": "sesame",
  "黒ゴマ傍点": "sesame",
  "ゴマ傍点": "sesame",
  "白ゴマ傍点": "white-sesame",
  "黒丸傍点": "black-circle",
  "丸傍点": "black-circle",
  "白丸傍点": "white-circle",
  "黒三角傍点": "black-triangle",
  "三角傍点": "black-triangle",
  "白三角傍点": "white-triangle",
  "二重丸傍点": "bullseye",
  "蛇の目傍点": "fisheye",
  "ばつ傍点": "saltire",
  "×傍点": "saltire",
};

const DECORATION_LABELS: Record<string, DecorationStyle> = {
  "傍線": "underline",
  "上線": "overline",
  "太字": "bold",
  "斜体": "italic",
};

type RangeResolution =
  | { kind: "emphasis"; style: EmphasisStyle }
  | { kind: "decoration"; style: DecorationStyle };

function lookupRangeStyle(label: string): RangeResolution | undefined {
  if (Object.prototype.hasOwnProperty.call(EMPHASIS_LABELS, label)) {
    return { kind: "emphasis", style: EMPHASIS_LABELS[label] };
  }
  if (Object.prototype.hasOwnProperty.call(DECORATION_LABELS, label)) {
    return { kind: "decoration", style: DECORATION_LABELS[label] };
  }
  return undefined;
}

// Implicit ruby base charset (spec §9.1): kanji script, 々/〆/ヵ/ヶ, and
// katakana (which already includes the chouon mark ー at U+30FC).
const BASE_CHAR_RE = /[々〆ヵヶ㐀-鿿豈-﫿゠-ヿ]/;

// Bounds on backward-reference windows (spec §17/§18.7): real Aozora base
// text and post-form targets are always a handful of characters, never far
// from where they're referenced. Bounding the window keeps every lookback
// O(1) instead of O(current buffer length) — without this bound, many
// post-form annotations targeting the same short word against a long,
// never-flushed buffer would be quadratic (spec §18.7's "同じ対象語を大量
// に含む後置注記" case).
const MAX_IMPLICIT_BASE_LOOKBACK = 64;
const MAX_POST_TARGET_LOOKBACK = 4096;

function truncateLabel(value: string): string {
  const chars = Array.from(value);
  return chars.length > 64 ? chars.slice(0, 64).join("") + "…" : value;
}

function isValidUnicodeScalarValue(cp: number): boolean {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false; // surrogate half
  if (cp >= 0xfdd0 && cp <= 0xfdef) return false; // noncharacter block
  const low16 = cp & 0xffff;
  if (low16 === 0xfffe || low16 === 0xffff) return false; // per-plane noncharacters
  return true;
}

export interface ParseInlineOptions {
  /** Receives every diagnostic this parse produces, already populated with
   * `line`/`column` — the caller (parse-document.ts) owns capping the
   * document-wide diagnostics list at MAX_DIAGNOSTICS; this file just
   * reports. Defaults to a no-op so parseInlineText is usable standalone
   * in tests. */
  pushDiagnostic?: (diagnostic: AozoraDiagnostic) => void;
  /** 1-based source line of this chunk's first line (best-effort —
   * diagnostics report the chunk's start line, not the exact annotation's
   * line/column within it). */
  line?: number;
}

interface RangeFrame {
  kind: "emphasis" | "decoration";
  style: EmphasisStyle | DecorationStyle;
  startIndex: number;
  originalAnnotationText: string;
}

export function parseInlineText(chunk: string, options: ParseInlineOptions = {}): AozoraInline[] {
  const line = options.line ?? 1;
  const emitDiagnostic = options.pushDiagnostic ?? ((): void => {});

  function pushDiag(kind: AozoraDiagnostic["kind"], annotationName?: string): void {
    emitDiagnostic({
      kind,
      severity: kind === "resource-limit" ? "error" : "warning",
      line,
      column: 0,
      ...(annotationName !== undefined ? { annotationName: truncateLabel(annotationName) } : {}),
    });
  }

  const nodes: AozoraInline[] = [];
  let textBuffer = "";
  // Set (to an accumulating string) while inside ｜…《 — i.e. after an
  // explicit ruby-base marker and before its ruby reading arrives.
  let explicitBase: string | undefined;
  const rangeStack: RangeFrame[] = [];

  function flushTextBuffer(): void {
    if (textBuffer.length > 0) {
      nodes.push({ type: "text", value: textBuffer });
      textBuffer = "";
    }
  }

  /** Aborts any in-progress ｜ explicit-base capture, restoring it as
   * literal text — called whenever something other than a ruby reading
   * (another ｜, an annotation, or EOF) interrupts the capture. */
  function abortExplicitBase(): void {
    if (explicitBase !== undefined) {
      textBuffer += "｜" + explicitBase;
      explicitBase = undefined;
    }
  }

  /** Pops a maximal trailing run of valid implicit-ruby-base characters off
   * the end of `textBuffer` (bounded lookback, spec §17/§18.7 — see
   * MAX_IMPLICIT_BASE_LOOKBACK), returning it, or undefined if the buffer's
   * last character doesn't qualify at all. */
  function extractImplicitBase(): string | undefined {
    if (textBuffer.length === 0) return undefined;
    const windowStart = Math.max(0, textBuffer.length - MAX_IMPLICIT_BASE_LOOKBACK * 2);
    const head = textBuffer.slice(0, windowStart);
    const window = Array.from(textBuffer.slice(windowStart));
    let start = window.length;
    while (start > 0 && BASE_CHAR_RE.test(window[start - 1])) {
      start--;
    }
    if (start === window.length) return undefined;
    const base = window.slice(start).join("");
    textBuffer = head + window.slice(0, start).join("");
    return base;
  }

  function handleRuby(reading: string, crossesNewline: boolean): void {
    let base: string | undefined;
    let usedExplicit = false;
    if (explicitBase !== undefined) {
      base = explicitBase;
      usedExplicit = true;
      explicitBase = undefined;
    } else {
      base = extractImplicitBase();
    }

    if (base === undefined || base.length === 0) {
      if (usedExplicit) textBuffer += "｜";
      textBuffer += "《" + reading + "》";
      pushDiag("ruby-without-base");
      return;
    }
    const basePrefix = usedExplicit ? "｜" : "";
    if (reading.length === 0) {
      textBuffer += basePrefix + base + "《》";
      pushDiag("malformed-annotation", "ルビ");
      return;
    }
    if (crossesNewline) {
      textBuffer += basePrefix + base + "《" + reading + "》";
      pushDiag("malformed-annotation", "ルビ");
      return;
    }
    if (Array.from(reading).length > MAX_RUBY_READING_CODEPOINTS) {
      textBuffer += basePrefix + base + "《" + reading + "》";
      pushDiag("resource-limit", "ルビ読み");
      return;
    }

    flushTextBuffer();
    nodes.push({ type: "ruby", base: [{ type: "text", value: base }], reading });
  }

  /** Wraps the last occurrence of `target` found within a bounded trailing
   * window of `textBuffer` (spec §9.4's "解析済みインラインノードの末尾
   * から...後方探索" — restricted here to the still-unflushed plain-text
   * tail, which covers the overwhelmingly common real case of the target
   * immediately preceding its annotation; never a raw-source
   * `lastIndexOf()`, spec §9.4's explicit prohibition, since this always
   * operates on the already-parsed buffer, not the original source
   * string). Returns false (nothing changed) when the target isn't found
   * in the window, so callers can fail soft. */
  function wrapTrailingTarget(target: string, build: (children: AozoraInline[]) => AozoraInline): boolean {
    const windowStart = Math.max(0, textBuffer.length - MAX_POST_TARGET_LOOKBACK);
    const window = textBuffer.slice(windowStart);
    const idxInWindow = window.lastIndexOf(target);
    if (idxInWindow === -1) return false;
    const idx = windowStart + idxInWindow;
    const before = textBuffer.slice(0, idx);
    const matched = textBuffer.slice(idx, idx + target.length);
    const after = textBuffer.slice(idx + target.length);
    textBuffer = before;
    flushTextBuffer();
    nodes.push(build([{ type: "text", value: matched }]));
    textBuffer = after;
    return true;
  }

  function applyGaiji(description: string, unicodeSpecRaw: string | undefined): void {
    let unicode: string | undefined;
    if (unicodeSpecRaw !== undefined) {
      const hexMatch = /^U\+([0-9A-Fa-f]{4,6})$/.exec(unicodeSpecRaw.trim());
      if (hexMatch) {
        const cp = parseInt(hexMatch[1], 16);
        if (isValidUnicodeScalarValue(cp)) {
          unicode = String.fromCodePoint(cp);
        }
      }
    }
    // Consume the ※ placeholder immediately preceding this annotation, if
    // present — the resolved glyph/fallback replaces it, it doesn't sit
    // alongside it.
    if (textBuffer.endsWith("※")) {
      textBuffer = textBuffer.slice(0, -1);
    }
    flushTextBuffer();
    nodes.push({ type: "gaiji", unicode, description });
  }

  function applyRangeStart(label: string, originalText: string): void {
    const resolved = lookupRangeStyle(label);
    if (!resolved) {
      flushTextBuffer();
      nodes.push({ type: "rawAnnotation", text: originalText });
      pushDiag("unsupported-annotation", label);
      return;
    }
    if (rangeStack.length >= MAX_RANGE_NESTING_DEPTH) {
      flushTextBuffer();
      nodes.push({ type: "rawAnnotation", text: originalText });
      pushDiag("resource-limit", label);
      return;
    }
    flushTextBuffer();
    rangeStack.push({
      kind: resolved.kind,
      style: resolved.style,
      startIndex: nodes.length,
      originalAnnotationText: originalText,
    });
  }

  function applyRangeEnd(label: string, originalText: string): void {
    const resolved = lookupRangeStyle(label);
    if (!resolved) {
      flushTextBuffer();
      nodes.push({ type: "rawAnnotation", text: originalText });
      pushDiag("unsupported-annotation", label);
      return;
    }
    const top = rangeStack[rangeStack.length - 1];
    if (!top || top.kind !== resolved.kind || top.style !== resolved.style) {
      flushTextBuffer();
      nodes.push({ type: "rawAnnotation", text: originalText });
      pushDiag("unmatched-end", label);
      return;
    }
    rangeStack.pop();
    flushTextBuffer();
    const wrapped = nodes.splice(top.startIndex, nodes.length - top.startIndex);
    if (top.kind === "emphasis") {
      nodes.push({ type: "emphasis", style: top.style as EmphasisStyle, children: wrapped });
    } else {
      nodes.push({ type: "decoration", style: top.style as DecorationStyle, children: wrapped });
    }
  }

  function applyPostConstruct(
    target: string,
    label: string,
    originalText: string,
    build: (children: AozoraInline[]) => AozoraInline,
    unrecognizedDiagnostic: AozoraDiagnostic["kind"],
  ): void {
    if (target.length === 0) {
      flushTextBuffer();
      nodes.push({ type: "rawAnnotation", text: originalText });
      pushDiag("malformed-annotation", label);
      return;
    }
    const wrapped = wrapTrailingTarget(target, build);
    if (!wrapped) {
      flushTextBuffer();
      nodes.push({ type: "rawAnnotation", text: originalText });
      pushDiag(unrecognizedDiagnostic, label);
    }
  }

  function handleAnnotation(rawBody: string): void {
    abortExplicitBase();
    const originalText = "［＃" + rawBody + "］";
    const bodyLen = Array.from(rawBody).length;

    if (bodyLen > MAX_ANNOTATION_CODEPOINTS) {
      textBuffer += originalText;
      pushDiag("resource-limit", "注記");
      return;
    }

    // 外字 (spec §9.10): 「description」[、U+XXXX] — matched broadly (any
    // trailing content after the closing 」, not just well-formed U+ hex)
    // so an invalid hex spec still resolves to the "no Unicode" fallback
    // instead of falling all the way through to a generic raw annotation.
    const gaijiMatch = /^「([^」]*)」(?:、\s*(.+))?$/.exec(rawBody);
    if (gaijiMatch) {
      applyGaiji(gaijiMatch[1], gaijiMatch[2]);
      return;
    }

    const rangeEndMatch = /^ここで(.+)終わり$/.exec(rawBody);
    if (rangeEndMatch) {
      applyRangeEnd(rangeEndMatch[1], originalText);
      return;
    }

    const rangeStartMatch = /^ここから(.+)$/.exec(rawBody);
    if (rangeStartMatch) {
      applyRangeStart(rangeStartMatch[1], originalText);
      return;
    }

    // 傍点／傍線／上線／太字／斜体 post-form: 「target」に<label>
    const postMatch = /^「([^」]*)」に(.+)$/.exec(rawBody);
    if (postMatch) {
      const [, target, label] = postMatch;
      const resolved = lookupRangeStyle(label);
      if (!resolved) {
        flushTextBuffer();
        nodes.push({ type: "rawAnnotation", text: originalText });
        pushDiag("unsupported-annotation", label);
        return;
      }
      const build =
        resolved.kind === "emphasis"
          ? (children: AozoraInline[]): AozoraInline => ({
              type: "emphasis",
              style: resolved.style as EmphasisStyle,
              children,
            })
          : (children: AozoraInline[]): AozoraInline => ({
              type: "decoration",
              style: resolved.style as DecorationStyle,
              children,
            });
      applyPostConstruct(target, label, originalText, build, "malformed-annotation");
      return;
    }

    // 縦中横 post-form: 「target」は縦中横
    const tcyMatch = /^「([^」]*)」は縦中横$/.exec(rawBody);
    if (tcyMatch) {
      applyPostConstruct(
        tcyMatch[1],
        "縦中横",
        originalText,
        (children) => ({ type: "tcy", children }),
        "malformed-annotation",
      );
      return;
    }

    // Anything else — including block-scope constructs (見出し, 改ページ,
    // 字下げ, 地付き, 中央寄せ) that reach here because they weren't
    // recognized as their own control chunk by parse-document.ts — is an
    // unsupported annotation: fail soft, kept visible verbatim (spec §9.11).
    flushTextBuffer();
    nodes.push({ type: "rawAnnotation", text: originalText });
    pushDiag("unsupported-annotation", rawBody);
  }

  for (const token of tokenizeAozoraChunk(chunk)) {
    switch (token.type) {
      case "text":
        if (explicitBase !== undefined) {
          explicitBase += token.value;
        } else {
          textBuffer += token.value;
        }
        break;
      case "pipe":
        abortExplicitBase();
        explicitBase = "";
        break;
      case "unclosedRuby":
        abortExplicitBase();
        textBuffer += token.raw;
        pushDiag("malformed-annotation", "ルビ");
        break;
      case "ruby":
        handleRuby(token.reading, token.crossesNewline);
        break;
      case "annotation":
        handleAnnotation(token.body);
        break;
      case "unclosedAnnotation":
        abortExplicitBase();
        textBuffer += token.raw;
        pushDiag("malformed-annotation", "注記");
        break;
    }
  }

  abortExplicitBase();
  flushTextBuffer();

  // Any range that never closed within this paragraph (spec §17's "後方参照
  // は現在段落内のみ" extends to range scope too, for this MVP): fail
  // soft — put the original opening annotation text back where it was
  // encountered, leave the content after it unwrapped, and diagnose.
  for (let idx = rangeStack.length - 1; idx >= 0; idx--) {
    const frame = rangeStack[idx];
    nodes.splice(frame.startIndex, 0, { type: "rawAnnotation", text: frame.originalAnnotationText });
    pushDiag("unclosed-range");
  }

  return nodes;
}
