// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Lexer for Aozora Bunko-style annotation syntax (spec §9 / §17). Two
 * exports:
 *
 * - `splitIntoParagraphChunks`: blank-line-run (`\n{2,}`) paragraph
 *   chunking, same boundary rule as plain TXT (text-html.ts's
 *   textToParagraphHtml), but also returning each chunk's 1-based starting
 *   line number (for AozoraDiagnostic.line) — computed by counting `\n`
 *   characters consumed so far, never by re-scanning from the start.
 * - `tokenizeAozoraChunk`: a single left-to-right pass over one paragraph
 *   chunk that recognizes ｜ (explicit ruby-base marker), 《…》 (ruby
 *   reading), and ［＃…］ (annotation) spans, yielding everything else as
 *   `text` runs. Deliberately does NOT interpret annotation bodies —
 *   parse-inline.ts / parse-document.ts own that semantic layer; this file
 *   only finds the spans.
 *
 * Complexity (spec §17's DoS-resistance requirements): every branch below
 * either advances the cursor `i` by a literal +1, or jumps it to the index
 * returned by `indexOf` (or to EOF when `indexOf` returns -1) — so `i` is
 * strictly non-decreasing and every `indexOf` scan starts at or after the
 * previous one's result. That makes the total work across all `indexOf`
 * calls in one pass bounded by the input length once (the scanned ranges
 * never overlap), so the whole function is O(n) regardless of how many
 * delimiters the input contains or how they're nested — an attacker
 * repeating `［＃` or `《` with no closing bracket anywhere still only
 * costs one linear scan (the first unclosed span swallows the rest of the
 * chunk and the loop ends), and any 1-character-per-loop path also
 * guarantees the "never zero-width-consume" / "always reach EOF" rules the
 * spec requires of this layer.
 */

export interface ParagraphChunk {
  /** Chunk text exactly as it appeared in the source (embedded single
   * newlines kept, spec §10.2 — this layer never joins/trims). */
  text: string;
  /** 1-based line number of the chunk's first line, for diagnostics. */
  startLine: number;
}

/**
 * Splits already-normalized (line-endings unified, control characters
 * stripped, NFC) body text into paragraph-level chunks on runs of 2+
 * newlines (spec §10.2: this must run on raw chunk boundaries only — it
 * must never collapse blank-line runs or trim trailing whitespace, that is
 * `plain`-only normalization). Uses a capturing split so the separator's
 * own newline count is available for line-number bookkeeping, without a
 * second pass over the text.
 */
export function splitIntoParagraphChunks(text: string): ParagraphChunk[] {
  const parts = text.split(/(\n{2,})/);
  const chunks: ParagraphChunk[] = [];
  let line = 1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 0) {
      chunks.push({ text: part, startLine: line });
      for (const ch of part) {
        if (ch === "\n") line++;
      }
    } else {
      // A pure-newline separator: every character in it is a line break.
      line += part.length;
    }
  }
  return chunks;
}

export type AozoraToken =
  | { type: "text"; value: string }
  /** ｜ (U+FF5C) — explicit ruby-base marker (spec §9.1). */
  | { type: "pipe" }
  /** A closed 《…》 span; `reading` is the raw text between the
   * delimiters, unvalidated (parse-inline.ts checks length/newline/empty). */
  | { type: "ruby"; reading: string; crossesNewline: boolean }
  /** A 《 with no matching 》 anywhere before EOF (spec §17's "未閉じ《は
   * EOFで必ず終了"). `raw` is the literal source text from the 《 onward,
   * for verbatim fail-soft display. */
  | { type: "unclosedRuby"; raw: string }
  /** A closed ［＃…］ span; `body` is the raw text between ＃ and ］,
   * unvalidated (parse-inline.ts / parse-document.ts own the 4096-codepoint
   * cap and the annotation-shape grammar). */
  | { type: "annotation"; body: string }
  /** A ［＃ with no matching ］ anywhere before EOF (same EOF-termination
   * rule as unclosedRuby). `raw` is the literal source text from ［＃
   * onward. */
  | { type: "unclosedAnnotation"; raw: string };

/**
 * Tokenizes one paragraph chunk (spec §9's inline/annotation lexical
 * layer). ※ (the 外字 placeholder marker, spec §9.10) is deliberately NOT
 * a distinct token here — it is an ordinary character that only becomes
 * meaningful when it immediately precedes a recognized 外字 annotation, a
 * judgment parse-inline.ts makes by inspecting the tail of its own
 * plain-text buffer, not something this purely-lexical layer can decide.
 */
export function tokenizeAozoraChunk(chunk: string): AozoraToken[] {
  const tokens: AozoraToken[] = [];
  const n = chunk.length;
  let i = 0;
  let textStart = 0;

  function flushText(end: number): void {
    if (end > textStart) {
      tokens.push({ type: "text", value: chunk.slice(textStart, end) });
    }
  }

  while (i < n) {
    const ch = chunk[i];

    if (ch === "｜") {
      flushText(i);
      tokens.push({ type: "pipe" });
      i += 1;
      textStart = i;
      continue;
    }

    if (ch === "《") {
      flushText(i);
      const close = chunk.indexOf("》", i + 1);
      if (close === -1) {
        tokens.push({ type: "unclosedRuby", raw: chunk.slice(i) });
        i = n;
        textStart = n;
        continue;
      }
      const reading = chunk.slice(i + 1, close);
      tokens.push({ type: "ruby", reading, crossesNewline: reading.includes("\n") });
      i = close + 1;
      textStart = i;
      continue;
    }

    // "］" without a preceding "［＃" is ordinary text — only the two-
    // character "［＃" sequence together opens an annotation.
    if (ch === "［" && chunk[i + 1] === "＃") {
      flushText(i);
      const close = chunk.indexOf("］", i + 2);
      if (close === -1) {
        tokens.push({ type: "unclosedAnnotation", raw: chunk.slice(i) });
        i = n;
        textStart = n;
        continue;
      }
      const body = chunk.slice(i + 2, close);
      tokens.push({ type: "annotation", body });
      i = close + 1;
      textStart = i;
      continue;
    }

    i += 1;
  }
  flushText(n);
  return tokens;
}
