// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { AozoraBlock, AozoraDocument, AozoraInline } from "./types";

/**
 * Allowlist HTML renderer for the Aozora AST (spec §9/§11). This is the
 * ONLY place in the whole feature that turns document-derived strings into
 * HTML tags: every tag and attribute emitted here comes from a fixed
 * literal set chosen by this code, never from the input. Every piece of
 * input-derived text (text values, ruby base/reading, gaiji description,
 * raw-annotation text) is escaped individually via `escapeHtml` — never
 * concatenated with another input-derived string before escaping (spec
 * §9.1's ruby base/reading independence requirement generalizes to every
 * node type here).
 *
 * Allowed tags (spec §11.2): p, br, h2, h3, h4, ruby, rb, rt, rp, span, em,
 * strong, div. Allowed attributes (spec §11.3): class, aria-hidden, title.
 * No other tag or attribute is ever written by this file — grep for `<` in
 * this file to audit the full set.
 */

/** Mandatory HTML-escaping — the sole defense against document-derived text
 * being interpreted as markup (mirrors src/text-html.ts's escapeHtml; kept
 * as an independent copy here because this package must not depend on
 * backend code). */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A `text` node's value may contain embedded newlines (spec §10.2: aozora
 * normalization does not join hard-wrapped lines, so every line break in
 * the source is meaningful) — rendered as `<br>`, exactly like plain TXT's
 * textToParagraphHtml. */
function renderTextValue(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

type EmphasisStyle = Extract<AozoraInline, { type: "emphasis" }>["style"];

const EMPHASIS_CLASS: Record<EmphasisStyle, string> = {
  sesame: "sesame_dot",
  "white-sesame": "white_sesame_dot",
  "black-circle": "black_circle",
  "white-circle": "white_circle",
  "black-triangle": "black_up-pointing_triangle",
  "white-triangle": "white_up-pointing_triangle",
  bullseye: "bullseye",
  fisheye: "fisheye",
  saltire: "saltire",
};

function renderInline(node: AozoraInline): string {
  switch (node.type) {
    case "text":
      return renderTextValue(node.value);
    case "ruby": {
      // base and reading are escaped completely independently (spec §9.1's
      // security note) — reading never flows through renderInlineChildren,
      // and base's rendered markup never gets treated as a string to
      // re-escape.
      const base = renderInlineChildren(node.base);
      const reading = escapeHtml(node.reading);
      return `<ruby><rb>${base}</rb><rp>（</rp><rt>${reading}</rt><rp>）</rp></ruby>`;
    }
    case "emphasis": {
      const cls = EMPHASIS_CLASS[node.style];
      return `<em class="${cls}">${renderInlineChildren(node.children)}</em>`;
    }
    case "decoration": {
      const children = renderInlineChildren(node.children);
      if (node.style === "underline") {
        return `<span class="underline_solid">${children}</span>`;
      }
      if (node.style === "overline") {
        return `<span class="overline_solid">${children}</span>`;
      }
      if (node.style === "bold") {
        return `<strong>${children}</strong>`;
      }
      return `<em class="shatai">${children}</em>`; // italic
    }
    case "tcy":
      return `<span class="tcy">${renderInlineChildren(node.children)}</span>`;
    case "gaiji":
      if (node.unicode !== undefined) {
        // Already resolved to a real character during parsing (spec
        // §9.10) — render as ordinary escaped text, no wrapper needed.
        return escapeHtml(node.unicode);
      }
      return `<span class="gaiji-fallback" title="${escapeHtml(node.description)}">〓</span>`;
    case "rawAnnotation":
      return `<span class="aozora-raw-note">${escapeHtml(node.text)}</span>`;
  }
}

function renderInlineChildren(children: AozoraInline[]): string {
  return children.map(renderInline).join("");
}

/** Selects the spec §9.6/§9.7 class for a paragraph, per the
 * `indentEm`/`align` contract documented on AozoraBlock's `paragraph`
 * variant (types.ts). Returns undefined when no class applies. */
function paragraphClassName(block: Extract<AozoraBlock, { type: "paragraph" }>): string | undefined {
  if (block.align === "center") {
    return "aozora-center";
  }
  if (block.align === "end") {
    const n = block.indentEm ?? 0;
    return n > 0 ? `chitsuki_${n}` : "chitsuki_0";
  }
  if (block.indentEm !== undefined && block.indentEm > 0) {
    return `jisage_${block.indentEm}`;
  }
  return undefined;
}

const HEADING_TAG: Record<1 | 2 | 3, "h2" | "h3" | "h4"> = { 1: "h2", 2: "h3", 3: "h4" };
const HEADING_SIZE_CLASS: Record<1 | 2 | 3, string> = {
  1: "aozora-heading-large",
  2: "aozora-heading-medium",
  3: "aozora-heading-small",
};

function renderBlock(block: AozoraBlock): string {
  switch (block.type) {
    case "paragraph": {
      const cls = paragraphClassName(block);
      const classAttr = cls !== undefined ? ` class="${cls}"` : "";
      return `<p${classAttr}>${renderInlineChildren(block.children)}</p>`;
    }
    case "heading": {
      const tag = HEADING_TAG[block.level];
      const classes = ["aozora-heading", HEADING_SIZE_CLASS[block.level]];
      if (block.variant === "inline") {
        classes.push("aozora-heading-inline");
      } else if (block.variant === "window") {
        classes.push("aozora-heading-window");
      }
      return `<${tag} class="${classes.join(" ")}">${renderInlineChildren(block.children)}</${tag}>`;
    }
    case "pageBreak":
      return `<div class="aozora-page-break" aria-hidden="true"></div>`;
    case "rawAnnotation":
      return `<p><span class="aozora-raw-note">${escapeHtml(block.text)}</span></p>`;
  }
}

/** Renders the document body (spec §9) — NOT the 底本 bibliography, which
 * has its own renderer below so callers can place it on a separate page. */
export function renderDocumentToHtml(document: AozoraDocument): string {
  return document.blocks.map(renderBlock).join("\n");
}

/** Renders the 底本 (source-edition) bibliography blocks, wrapped in the
 * shared `.bibliographical_information` class (spec §8.4/§12.2) so it
 * breaks onto its own page like the URL-extraction path's colophon. Returns
 * "" when there is nothing to show. */
export function renderBibliographyToHtml(bibliography: AozoraBlock[]): string {
  if (bibliography.length === 0) {
    return "";
  }
  return `<div class="bibliographical_information">\n${bibliography.map(renderBlock).join("\n")}\n</div>`;
}

/** Flattens every piece of user-visible text in the document (paragraph/
 * heading text, ruby base and reading, gaiji description/resolved
 * character) into one string, for font-subsetting purposes
 * (src/text-prepare.ts's searchableText / spec §12's inlined-font-subset
 * input) — deliberately NOT HTML, and NOT run through escapeHtml. */
export function extractPlainText(document: AozoraDocument): string {
  const parts: string[] = [];
  function visitInline(node: AozoraInline): void {
    switch (node.type) {
      case "text":
        parts.push(node.value);
        return;
      case "ruby":
        for (const child of node.base) visitInline(child);
        parts.push(node.reading);
        return;
      case "emphasis":
      case "decoration":
      case "tcy":
        for (const child of node.children) visitInline(child);
        return;
      case "gaiji":
        parts.push(node.unicode ?? node.description);
        return;
      case "rawAnnotation":
        parts.push(node.text);
        return;
    }
  }
  function visitBlock(block: AozoraBlock): void {
    switch (block.type) {
      case "paragraph":
      case "heading":
        for (const child of block.children) visitInline(child);
        return;
      case "pageBreak":
        return;
      case "rawAnnotation":
        parts.push(block.text);
        return;
    }
  }
  for (const block of document.blocks) visitBlock(block);
  for (const block of document.bibliography) visitBlock(block);
  return parts.join("\n");
}
