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

  /** Finds the index of the `」` that closes `rawBody`'s outer `「` (spec
   * §9.10's 外字 description quote — `rawBody[0]` is already known to be
   * `「` by the caller), tracking `「`/`」` nesting depth instead of
   * stopping at the first `」` regardless of nesting. This is what lets a
   * description that itself quotes something (e.g. `「あ「い」う」、
   * U+XXXX` — the whole `あ「い」う` is the description) be found
   * correctly; a single `[^」]*` capture cannot express "skip past a
   * balanced nested pair", so it used to stop at the first `」` no matter
   * what came after it (spec §4.3 regression this replaces: unrelated text
   * that happened to follow a 、 right after that first, wrong `」` was
   * silently discarded as a "malformed hex spec" — see the caller).
   * Returns undefined if depth never returns to 0 (no real closing 」 for
   * this 「 anywhere in the body) — the caller falls through to ordinary
   * unsupported-annotation handling, the same fail-soft as an unclosed
   * ［＃ or 《, spec §17. O(rawBody.length), single left-to-right pass, no
   * backtracking; rawBody is already capped at MAX_ANNOTATION_CODEPOINTS
   * by the caller before this ever runs. */
  function findGaijiOuterClose(rawBody: string): number | undefined {
    let depth = 0;
    for (let i = 0; i < rawBody.length; i++) {
      const ch = rawBody[i];
      if (ch === "「") depth++;
      else if (ch === "」") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return undefined;
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

  /** Maps every full-width ASCII variant (U+FF01–U+FF5E, the "Fullwidth
   * Forms" block — full-width digits/letters/punctuation, e.g. "０"–"９",
   * "Ａ"–"Ｚ", "＋") to its ordinary half-width ASCII counterpart
   * (U+0021–U+007E) via the standard fixed -0xFEE0 offset between the two
   * blocks. Used so `isGaijiCodeSpec` (below) can accept 全角 digits (区点
   * numbers, 水準 level digits) and 全角 "Ｕ＋" with a SINGLE consistent
   * rule instead of duplicating half-width/full-width variants inside
   * every character class — real Aozora files mix both conventions (spec
   * review: "６０-８" and "Ｕ＋XXXX" both appear), and matching only one of
   * the two would just be another under-acceptance regression of the same
   * shape this whole allowlist exists to avoid. Never applied to
   * `description` or any other document text — only to the already-
   * isolated trailing code-spec candidate, so this can never alter what a
   * reader actually sees for anything except deciding "is this a code
   * spec". */
  function normalizeFullWidthAscii(value: string): string {
    return value.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  }

  /** True iff `spec` (already trimmed) looks like an attempted 外字 code
   * specification, spec §9.10 — the SOLE place this project decides "is
   * this a code spec, or is it ordinary text" (handleAnnotation's gaiji
   * branch below is the only caller; keeping this decision in exactly one
   * place is deliberate, so it can never quietly drift out of sync with
   * itself). Checked against `normalizeFullWidthAscii(spec)` throughout —
   * see that function's doc comment — so half-width and full-width digit
   * conventions are accepted identically. Real-world Aozora Bunko 外字注記
   * uses two notation families, both accepted here:
   *
   * - `U+<tail>` (half- or full-width "Ｕ＋"): a Unicode code point hex
   *   escape (spec's own example) — accepted when `<tail>` is ASCII
   *   letters/digits ONLY (any length, including empty), deliberately NOT
   *   validated as actually-well-formed hex here: `applyGaiji`'s own
   *   regex + `isValidUnicodeScalarValue` already do that strict check to
   *   decide whether to actually resolve a character, and a malformed
   *   attempt (wrong digit count, non-hex letters, an out-of-range/
   *   surrogate/noncharacter code point) must keep degrading to the
   *   description-only fallback exactly as it always has (spec's own
   *   existing tests: rejects U+D800/U+110000/U+FFFE/U+ZZZZ, all still
   *   `{ type: "gaiji", description }`, never a raw annotation) — this
   *   function must NOT re-validate hex shape, only that the tail is at
   *   least PLAUSIBLY code-like (ASCII alnum), or it would re-introduce
   *   exactly the under-acceptance class this allowlist exists to avoid.
   *   The ASCII-alnum requirement is what's new here versus an earlier,
   *   too-loose version of this same gate that accepted ANY trailing
   *   content after `U+`/`Ｕ＋` — which meant a nested-quote continuation
   *   that merely happened to *start* with "U+" (e.g. "U+ある特殊文字を
   *   指す") got routed into `applyGaiji` and its Japanese-text tail
   *   silently discarded as a "malformed hex spec": the exact same
   *   silent-content-loss failure mode this whole area of the file exists
   *   to eliminate, just triggered by "U+" instead of a nested 「」.
   * - `<n1>-<n2>[-<n3>...]`, optionally prefixed `第<level>水準` (e.g.
   *   "60-8", "第3水準1-14-95", "1-84-17" with no prefix, "第４水準2-88-74"
   *   with a full-width level digit): Aozora Bunko's 区点/水準 notation —
   *   JIS X 0208 区点番号 is un-prefixed 区-点 (2 numbers); JIS X 0213
   *   補助漢字 references add a `第N水準` prefix (N is 1–4) and a 面-区-点
   *   triple (3 numbers) — but real files are not perfectly uniform about
   *   which shape carries the prefix (this fix's own regression report:
   *   "1-84-17" with 3 numbers and NO 水準 prefix), so the prefix is
   *   optional and the number-group count is 2-or-more rather than fixed
   *   at exactly 2 or exactly 3. Real examples: this project's own
   *   claudedocs/aozora-fallback-boundary-improvement-spec.md:399
   *   (「さんずい＋幼」、60-8, from 青空文庫's 浄火) plus this fix's own
   *   regression reports (第3水準1-14-95, 第4水準2-88-74, 1-84-17). Unlike
   *   `U+`, this family has no pre-existing "malformed but still
   *   accepted" contract to preserve, so it stays shape-strict (a run of
   *   2+ hyphen-joined decimal groups, optionally 水準-prefixed) rather
   *   than similarly loose — a genuinely malformed 区点/水準 spec (no
   *   known real file has one) falls through as ordinary text instead,
   *   fail-soft, verbatim, never silently dropped either way.
   *
   * Deliberately an ALLOWLIST, not a "reject Japanese prose" denylist:
   * `applyGaiji` never actually resolves 区点/水準 forms to a real
   * character (there is no JIS-charset table in this codebase — only a
   * well-formed half-width `U+XXXX` ever produces a real `unicode`
   * value), so this only decides "route through applyGaiji's
   * description-only fallback (spec's existing, unchanged behavior for
   * any spec it can't resolve) vs. fall through as ordinary text".
   * Under-accepting a real code spec here would silently degrade a clean
   * 外字 display into raw bracket notation (this fix's own regression,
   * caused by an earlier, narrower version of this same gate); the `U+`
   * branch's ASCII-alnum requirement is the one place this file
   * deliberately does NOT "err generous" the same way, because over-
   * accepting there is exactly what re-opened the silent-content-loss
   * hole this paragraph starts with.
   *
   * Complexity: no nested/repeated quantifiers anywhere — `\d+` and
   * `[0-9A-Za-z]` are each used at a single quantifier level, never
   * wrapped in another repeated group (e.g. never shaped like `(\d+-)+`
   * where the same characters could be reattributed between an inner and
   * outer `+`), so there is no catastrophic-backtracking case: every
   * branch is O(spec.length), same as every other regex in this file
   * (spec §17's O(n) guarantee; see parse-inline.test.ts's performance
   * assertions for this function specifically). */
  function isGaijiCodeSpec(spec: string): boolean {
    const normalized = normalizeFullWidthAscii(spec);
    if (normalized.startsWith("U+")) {
      return /^[0-9A-Za-z]*$/.test(normalized.slice(2));
    }
    return /^(?:第[0-9]水準)?\d+(?:-\d+)+$/.test(normalized);
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

    // 外字 (spec §9.10): 「description」[、<code spec>]. `description` may
    // itself contain a nested 「...」 pair (findGaijiOuterClose handles
    // that); a malformed-but-attempted code spec (wrong digit count, a
    // code shape isGaijiCodeSpec accepts but applyGaiji can't actually
    // resolve — everything except well-formed half-width `U+XXXX` falls
    // in this bucket, since only that exact form ever maps to a real
    // character) still resolves to the "no Unicode" description-only
    // fallback rather than falling through to a generic raw annotation —
    // that part of the original design is unchanged, see applyGaiji's own
    // validation. What matters here is only "does this look like ANY of
    // the code spec shapes Aozora Bunko actually uses, without also being
    // so loose it swallows unrelated prose" (isGaijiCodeSpec — U+<ASCII
    // alnum tail>, 区点番号, or (optionally 水準-prefixed) N-or-more
    // hyphen-joined numbers; see its own doc comment for the full
    // reasoning, real examples, and the two separate under/over-
    // acceptance regressions this exact function's history already went
    // through). Trailing content that matches none of those shapes falls
    // through instead, ending up verbatim in the generic raw-annotation
    // branch at the bottom of this function, never dropped.
    if (rawBody.startsWith("「")) {
      const closeIdx = findGaijiOuterClose(rawBody);
      if (closeIdx !== undefined) {
        const description = rawBody.slice(1, closeIdx);
        const afterClose = rawBody.slice(closeIdx + 1);
        if (afterClose.length === 0) {
          applyGaiji(description, undefined);
          return;
        }
        const trailing = /^、\s*(.+)$/.exec(afterClose);
        if (trailing && isGaijiCodeSpec(trailing[1].trim())) {
          applyGaiji(description, trailing[1]);
          return;
        }
        // afterClose exists but isn't a recognized "、<code spec>" shape
        // at all — falls through below, verbatim.
      }
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
