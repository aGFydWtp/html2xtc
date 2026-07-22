// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Intermediate representation for Aozora Bunko-style TXT input
 * (html2xtc-aozora-text-conversion-spec.md §7). This package is pure
 * TypeScript, DOM-independent, and has no Node.js/Cloudflare/network
 * dependency — the AST here is a plain, structurally-cloneable/serializable
 * object graph shared verbatim between the backend (src/text-prepare.ts) and
 * the Svelte frontend preview (spec §14.1's "production and preview run the
 * same preparation").
 *
 * Resource limits (spec §17) that constrain how these types get populated:
 * - a single annotation body: 4096 code points
 * - a ruby reading: 256 code points
 * - range-annotation nesting depth: 32
 * - AozoraDocument.diagnostics: at most 200 entries (see AozoraDiagnostic)
 * - AST node count: at most 1,000,000 (parser must error out deterministically,
 *   without echoing document contents, past this — see parse-document.ts)
 */

/** The parsed document: recognized front-matter (spec §8.2) plus the body
 * blocks, any 底本 (source-edition) blocks separated out for end-of-document
 * display (spec §8.4/§12.2's .bibliographical_information), and the
 * diagnostics collected while parsing. */
export interface AozoraDocument {
  title?: string;
  author?: string;
  blocks: AozoraBlock[];
  bibliography: AozoraBlock[];
  diagnostics: AozoraDiagnostic[];
}

/** Block-level structure (spec §7.2). A `paragraph`'s `indentEm` pairs with
 * `align` to select which spec §9.6/§9.7 CSS class family the renderer
 * emits (see render-html.ts's paragraphClassName): `align !== "end"` maps a
 * defined `indentEm` to `jisage_<N>` (字下げ, indent from the start edge),
 * `align === "end"` maps it to `chitsuki_<N>` (地付き/地から字上げ, indent
 * from the end edge, `chitsuki_0` when `indentEm` is absent or 0). */
export type AozoraBlock =
  | {
      type: "paragraph";
      children: AozoraInline[];
      indentEm?: number;
      align?: "start" | "center" | "end";
    }
  | {
      type: "heading";
      level: 1 | 2 | 3;
      variant: "normal" | "inline" | "window";
      children: AozoraInline[];
    }
  | {
      type: "pageBreak";
      kind: "page" | "sheet" | "spread" | "column";
    }
  | {
      /** An annotation the parser recognized but does not (yet) render
       * structurally — fail-soft per spec §4.3: the original bracketed text
       * is kept verbatim (escaped at render time) rather than dropped. */
      type: "rawAnnotation";
      text: string;
    };

/** Inline-level structure (spec §7.3). `emphasis.style` enumerates the 9
 * 傍点 (dot-emphasis) marks (spec §9.4); `decoration.style` the 4 line/weight
 * treatments (spec §9.5). */
export type AozoraInline =
  | { type: "text"; value: string }
  | {
      /** Ruby annotation (spec §9.1). `base` and `reading` are rendered and
       * HTML-escaped completely independently — render-html.ts must never
       * concatenate them before escaping. */
      type: "ruby";
      base: AozoraInline[];
      reading: string;
    }
  | {
      type: "emphasis";
      style:
        | "sesame"
        | "white-sesame"
        | "black-circle"
        | "white-circle"
        | "black-triangle"
        | "white-triangle"
        | "bullseye"
        | "fisheye"
        | "saltire";
      children: AozoraInline[];
    }
  | {
      type: "decoration";
      style: "underline" | "overline" | "bold" | "italic";
      children: AozoraInline[];
    }
  | {
      /** 縦中横 (spec §9.9): rendered as an inline run, degrades to plain
       * inline text under horizontal layout. */
      type: "tcy";
      children: AozoraInline[];
    }
  | {
      /** 外字 (spec §9.10). `unicode`, when present, is the already-resolved
       * real character (validated scalar value, never a surrogate half or
       * noncharacter) — render-html.ts emits it as ordinary escaped text.
       * When absent, `description` (the original 外字注記 label, e.g.
       * "土へん＋奇") is shown as the `title` attribute of a
       * `.gaiji-fallback` placeholder glyph. */
      type: "gaiji";
      unicode?: string;
      description: string;
    }
  | {
      /** An inline annotation the parser recognized but does not (yet)
       * render structurally (spec §9.11) — kept as escaped raw text inline
       * with a `.aozora-raw-note` wrapper, never dropped. */
      type: "rawAnnotation";
      text: string;
    };

/** Diagnostic entries never hold document body text beyond a bounded
 * `annotationName` label (spec §7.4) — no full-body or long-excerpt
 * capture, so diagnostics are always safe to log in aggregate (counts only,
 * per the "never log body/title/author/generated HTML" constraint that
 * spans this whole feature). */
export interface AozoraDiagnostic {
  kind:
    | "unsupported-annotation"
    | "malformed-annotation"
    | "unmatched-end"
    | "unclosed-range"
    | "ruby-without-base"
    | "resource-limit";
  severity: "warning" | "error";
  line: number;
  column: number;
  annotationName?: string;
}

/** Hard cap on AozoraDocument.diagnostics.length (spec §7.4/§17): once hit,
 * parsers stop pushing further diagnostic entries (the caller only knows a
 * cap was hit via PreparedTextDocument.diagnostics.truncatedDiagnostics —
 * see src/text-prepare.ts). */
export const MAX_DIAGNOSTICS = 200;

/** Hard cap on total AST node count (spec §17): blocks + inline nodes,
 * recursively. Exceeding this is a deterministic, content-free error, not a
 * per-node diagnostic. */
export const MAX_AST_NODES = 1_000_000;

/** Hard cap on range-annotation nesting depth (spec §17), e.g. nested
 * `［＃ここから…］…［＃ここで…終わり］` regions. */
export const MAX_RANGE_NESTING_DEPTH = 32;

/** Hard cap on a single annotation body's length, in code points (spec §17). */
export const MAX_ANNOTATION_CODEPOINTS = 4096;

/** Hard cap on a ruby reading's length, in code points (spec §9.1/§17). */
export const MAX_RUBY_READING_CODEPOINTS = 256;
