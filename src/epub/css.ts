// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { hasDisallowedUrlScheme } from "./assets";

/**
 * CSS sanitization (EPUB spec §10, design decision D2): a hand-written
 * tokenizer + allowlist-property sanitizer, NOT a single regular
 * expression — spec §22 explicitly forbids the latter ("CSSの安全化を正規
 * 表現1本だけで済ませない"). No new dependency is added (D2): the parser
 * below only needs to (a) split top-level `{ }` blocks, `;`-terminated
 * declarations and at-rule statements while respecting strings/parens, and
 * (b) walk an allowlist per declaration — both trivial enough to hand-roll
 * safely for this codebase's needs, unlike full CSSOM parsing.
 *
 * `@import` and `@font-face` are dropped outright (D2 spec §10.2, D3 spec
 * §10.3 respectively); every other unrecognized at-rule is dropped too
 * (safe default) except `@media`/`@page`/`@supports`, whose nested rules are
 * sanitized recursively with the exact same declaration allowlist (spec:
 * "@media / @page などのat-ruleはネストを正しく扱うこと").
 */

// --- tokenizer -----------------------------------------------------------

interface DeclarationNode {
  readonly kind: "decl";
  readonly prop: string;
  readonly value: string;
}

interface RuleNode {
  readonly kind: "rule";
  readonly selector: string;
  readonly body: DeclarationNode[];
}

interface AtRuleListNode {
  readonly kind: "at-rule-list";
  readonly name: string;
  readonly prelude: string;
  readonly body: CssNode[];
}

/** `@page { ... }`'s block holds declarations directly (like a rule body), not nested rules — unlike `@media`/`@supports`. */
interface AtDeclarationBlockNode {
  readonly kind: "at-decl-block";
  readonly name: string;
  readonly prelude: string;
  readonly body: DeclarationNode[];
}

type CssNode = RuleNode | AtRuleListNode | AtDeclarationBlockNode;

/** at-rule names whose `{ }` block is a declaration list (like a plain rule), not a nested rule list. */
const DECLARATION_BODY_AT_RULES: ReadonlySet<string> = new Set(["page", "font-face"]);

/**
 * Strips `/* ... *‍/` comments outside of string literals. Never throws on
 * an unterminated comment (spec: malformed CSS must not crash). Exported
 * (not just an internal step of sanitizeCss) because html.ts's detectLayout
 * also needs comments stripped before its own raw-text
 * `/writing-mode:\s*vertical-rl/` regex scan — without it, a commented-out
 * `/* writing-mode: vertical-rl; *‍/` in the EPUB's own CSS would still
 * match and mis-detect a horizontal book as vertical under layout="auto".
 * That regex scan intentionally stops here, at comment-stripping, rather
 * than running the EPUB's CSS through the full sanitizeCss allowlist
 * pipeline: it needs the RAW property value (sanitizeCss now drops
 * `writing-mode` outright — see ALLOWED_PROPERTIES below), just with
 * comments (the one construct trivially confusable with real, active CSS)
 * removed. It does NOT understand at-rule conditions, so a
 * `@supports (writing-mode: vertical-rl) { ... }` block whose condition
 * never actually applies can still cause a false-positive "vertical"
 * detection — accepted as out of scope (spec's own "auto" detection was
 * always a best-effort heuristic, not a full CSS engine).
 */
export function stripComments(css: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < css.length) {
    const ch = css[i] as string;
    if (quote !== null) {
      out += ch;
      if (ch === "\\" && i + 1 < css.length) {
        out += css[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Mutable cursor shared by the small set of scanning helpers below. */
interface Cursor {
  readonly src: string;
  pos: number;
}

/**
 * Scans forward from `cur.pos` until an unescaped, unquoted, top-level
 * (paren-depth 0) character in `stopChars` is found (or EOF), respecting
 * string literals and nested parens so a `;`/`{`/`}` inside `url("a;b")` or
 * a quoted string never ends the scan early. Returns the text scanned
 * (excluding the stop character) and leaves `cur.pos` AT the stop character
 * (or at src.length on EOF) so the caller can inspect/consume it.
 */
function scanTopLevelUntil(cur: Cursor, stopChars: string): string {
  const start = cur.pos;
  let depth = 0;
  let quote: string | null = null;
  while (cur.pos < cur.src.length) {
    const ch = cur.src[cur.pos] as string;
    if (quote !== null) {
      if (ch === "\\" && cur.pos + 1 < cur.src.length) {
        cur.pos += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      cur.pos++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur.pos++;
      continue;
    }
    if (ch === "(") {
      depth++;
      cur.pos++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur.pos++;
      continue;
    }
    if (depth === 0 && stopChars.includes(ch)) {
      return cur.src.slice(start, cur.pos);
    }
    cur.pos++;
  }
  return cur.src.slice(start, cur.pos);
}

/** Consumes a `{ ... }` block already positioned just after the opening `{`, honoring nested braces/strings/parens, returning the inner text (excluding the outer braces) and leaving `cur.pos` just after the matching `}` (or at EOF if unterminated — malformed CSS must not throw). */
function scanBalancedBlock(cur: Cursor): string {
  const start = cur.pos;
  let depth = 1;
  let quote: string | null = null;
  while (cur.pos < cur.src.length && depth > 0) {
    const ch = cur.src[cur.pos] as string;
    if (quote !== null) {
      if (ch === "\\" && cur.pos + 1 < cur.src.length) {
        cur.pos += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      cur.pos++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur.pos++;
      continue;
    }
    if (ch === "{") {
      depth++;
      cur.pos++;
      continue;
    }
    if (ch === "}") {
      depth--;
      cur.pos++;
      continue;
    }
    cur.pos++;
  }
  const end = depth === 0 ? cur.pos - 1 : cur.pos;
  return cur.src.slice(start, end);
}

function parseAtRuleHeader(header: string): { name: string; prelude: string } {
  const trimmed = header.trim();
  const spaceIdx = trimmed.search(/\s/);
  const rawName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const prelude = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  return { name: rawName.slice(1).toLowerCase(), prelude };
}

/** Splits a `{ ... }` block's inner text into `prop: value` declarations, tolerating malformed entries (missing colon, trailing garbage) by skipping them rather than throwing. */
function parseDeclarations(body: string): DeclarationNode[] {
  const declarations: DeclarationNode[] = [];
  const cur: Cursor = { src: body, pos: 0 };
  while (cur.pos < cur.src.length) {
    const chunk = scanTopLevelUntil(cur, ";");
    if (cur.pos < cur.src.length) {
      cur.pos++; // consume ';'
    }
    const colonIdx = chunk.indexOf(":");
    if (colonIdx === -1) {
      continue; // malformed declaration with no colon — skip
    }
    const prop = chunk.slice(0, colonIdx).trim().toLowerCase();
    const value = chunk.slice(colonIdx + 1).trim();
    if (prop.length === 0 || value.length === 0) {
      continue;
    }
    declarations.push({ kind: "decl", prop, value });
  }
  return declarations;
}

/** Top-level CSS parse: a flat list of rule/at-rule nodes. Recurses into `@media`/`@page`/`@supports` bodies via the same function. Never throws — anything unparseable is simply skipped (spec: malformed CSS must not crash). */
function parseCssNodes(css: string): CssNode[] {
  const cur: Cursor = { src: css, pos: 0 };
  const nodes: CssNode[] = [];
  while (cur.pos < cur.src.length) {
    // Skip whitespace and stray/unbalanced closing braces from a prior
    // malformed block.
    while (cur.pos < cur.src.length && (/\s/.test(cur.src[cur.pos] as string) || cur.src[cur.pos] === "}")) {
      cur.pos++;
    }
    if (cur.pos >= cur.src.length) {
      break;
    }
    const header = scanTopLevelUntil(cur, "{;}");
    const stop = cur.src[cur.pos];
    if (stop === "{") {
      cur.pos++;
      const body = scanBalancedBlock(cur);
      const trimmedHeader = header.trim();
      if (trimmedHeader.startsWith("@")) {
        const { name, prelude } = parseAtRuleHeader(trimmedHeader);
        if (DECLARATION_BODY_AT_RULES.has(name)) {
          nodes.push({ kind: "at-decl-block", name, prelude, body: parseDeclarations(body) });
        } else {
          nodes.push({ kind: "at-rule-list", name, prelude, body: parseCssNodes(body) });
        }
      } else if (trimmedHeader.length > 0) {
        nodes.push({ kind: "rule", selector: trimmedHeader, body: parseDeclarations(body) });
      }
      continue;
    }
    if (stop === ";") {
      cur.pos++; // a bare at-rule statement (e.g. @import ...;) — dropped by design, nothing to keep
      continue;
    }
    // EOF with leftover, non-terminated header — nothing usable, stop.
    break;
  }
  return nodes;
}

// --- sanitizing ------------------------------------------------------------

/** Resolves a `url()` reference already known to be a same-archive relative path (no disallowed scheme) to a data: URL, or undefined to drop the declaration entirely. Bound by the caller (html.ts) to the stylesheet's own archive path. */
export type CssUrlResolver = (rawUrl: string) => string | undefined;

/**
 * Every property this sanitizer keeps. Deliberately excludes anything that
 * can carry executable/interactive behavior (`behavior`, `-moz-binding` —
 * simply never listed, so the allowlist itself is the removal mechanism),
 * anything meaningless in a static PDF capture (`animation*`,
 * `transition*`), and `content`/`filter`/`transform`, which are not needed
 * for EPUB reading layout and would otherwise widen the url()/expression()
 * surface for no reader-visible benefit.
 *
 * `writing-mode` is the one deliberate exception to "preserve whatever the
 * EPUB's own CSS says": it is dropped here, everywhere it can appear
 * (stylesheets, inline `<style>`, inline `style=""` — this allowlist is the
 * single choke point for all three), so html.ts's own correction CSS is the
 * ONLY place `writing-mode` is ever declared in the generated document. Two
 * concrete, demonstrated reasons: (1) an EPUB that ships its own
 * `body { writing-mode: ... }` otherwise wins over html.ts's root-level
 * rule for that element (an element's own declaration always beats an
 * inherited one, `!important` or not — CSS cascades per element, not
 * across the tree), which silently defeats an explicit (non-"auto")
 * `layout` choice; single-sourcing writing-mode fixes that unconditionally.
 * (2) real-world 青空文庫-derived EPUBs routinely declare
 * `html, body { writing-mode: vertical-rl }` themselves, so leaving it
 * allowed doesn't just risk an override failure, it's the *common* case.
 * `text-orientation` (and everything else on spec's original preserve list
 * — text-combine-upright, text-emphasis*, ruby-position, break-*,
 * page-break-*, white-space, text-align, line-height) has no such
 * override/duplication concern (it doesn't establish a
 * block-progression/fragmentation context the way writing-mode does) and
 * stays allowed.
 *
 * Trade-off: sanitizeDeclaration (below) decides purely by property name,
 * never by selector — so this drops EVERY `writing-mode` declaration in an
 * EPUB's CSS, not just the `html`/`body`-level ones the override bug above
 * is actually about. A book that locally flips a single element's run
 * direction (e.g. a `.horizontal-note { writing-mode: horizontal-tb }`
 * aside inside an otherwise-vertical chapter) loses that local override
 * too — it renders in the document's overall layout direction instead.
 * Accepted: html.ts's own correction CSS has no way to know which specific
 * descendants an EPUB intended to flip, so there is no drop-in replacement
 * for a lost local override; the alternative (a selector-aware allowlist
 * that only strips root-level writing-mode) would reintroduce the override
 * bug for any EPUB whose local override happens to sit on `html`/`body`
 * anyway, which is the common case this exists to fix.
 */
const ALLOWED_PROPERTIES: ReadonlySet<string> = new Set([
  "color",
  "background",
  "background-color",
  "background-image",
  "background-repeat",
  "background-position",
  "background-size",
  "background-attachment",
  "background-clip",
  "background-origin",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-indent",
  "text-decoration",
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-color",
  "text-transform",
  "text-shadow",
  "text-overflow",
  "white-space",
  "word-break",
  "overflow-wrap",
  "word-wrap",
  "text-orientation",
  "text-combine-upright",
  "text-emphasis",
  "text-emphasis-style",
  "text-emphasis-color",
  "text-emphasis-position",
  "ruby-position",
  "ruby-align",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "border-collapse",
  "border-spacing",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "float",
  "clear",
  "overflow",
  "overflow-x",
  "overflow-y",
  "visibility",
  "box-sizing",
  "vertical-align",
  "z-index",
  "list-style",
  "list-style-type",
  "list-style-position",
  "list-style-image",
  "table-layout",
  "caption-side",
  "empty-cells",
  "break-before",
  "break-after",
  "break-inside",
  "page-break-before",
  "page-break-after",
  "page-break-inside",
  "opacity",
  "quotes",
  "direction",
  "unicode-bidi",
  "hyphens",
  "box-shadow",
  "object-fit",
  "object-position",
]);

/** at-rule names whose nested block is sanitized and kept; every other at-rule (including "import" and "font-face") is dropped outright. */
const KEPT_AT_RULE_BLOCKS: ReadonlySet<string> = new Set(["media", "page", "supports"]);

/** Absolute-unit tokens (`<number><unit>`) approximated to px for the size/margin guard-rails below. Relative units (%, em, rem, vh, vw) are intentionally not scanned — they can't encode an absolute pixel bomb the way `999999px` can. */
const ABS_LENGTH_TOKEN = /(-?\d+(?:\.\d+)?)(px|pt|in|cm|mm|pc)/gi;
const PX_PER_UNIT: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  in: 96,
  cm: 37.8,
  mm: 3.78,
  pc: 16,
};

/** True when `value` contains an absolute-length token whose magnitude exceeds `maxAbsPx` (spec §10.2's "printを破壊する巨大サイズ" / "極端な負のmargin" guards). */
function hasExtremeAbsoluteLength(value: string, maxAbsPx: number): boolean {
  ABS_LENGTH_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ABS_LENGTH_TOKEN.exec(value)) !== null) {
    const number = Number(match[1]);
    const unit = (match[2] as string).toLowerCase();
    const px = Math.abs(number) * (PX_PER_UNIT[unit] ?? 1);
    if (px > maxAbsPx) {
      return true;
    }
  }
  return false;
}

const MAX_SIZE_PX = 20_000;
const MAX_NEGATIVE_MARGIN_PX = 2_000;
const SIZE_GUARDED_PROPERTIES = new Set([
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "font-size",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-indent",
]);
const MARGIN_PROPERTIES = new Set([
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
]);

const DANGEROUS_VALUE_PATTERN = /expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/i;

const URL_FUNCTION = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/**
 * Rewrites every `url()` in `value` via `resolveUrl`. Returns undefined
 * (meaning: drop the whole declaration) if ANY url() reference has a
 * disallowed scheme or fails to resolve — a partially-broken multi-layer
 * `background` shorthand is not a safe half-measure. Returns `value`
 * unchanged when it contains no `url()` at all.
 */
function rewriteUrls(value: string, resolveUrl: CssUrlResolver): string | undefined {
  if (!/url\(/i.test(value)) {
    return value;
  }
  let failed = false;
  const rewritten = value.replace(URL_FUNCTION, (_all, _quote: string, raw: string) => {
    const trimmed = raw.trim();
    if (hasDisallowedUrlScheme(trimmed)) {
      failed = true;
      return "";
    }
    const resolved = resolveUrl(trimmed);
    if (resolved === undefined) {
      failed = true;
      return "";
    }
    return `url("${resolved}")`;
  });
  return failed ? undefined : rewritten;
}

/**
 * Sanitizes an at-rule prelude (the condition text between `@media`/
 * `@supports` and its `{`) the same way a declaration value is sanitized
 * (review H1): `hasDisallowedUrlScheme` alone only catches a prelude that
 * itself STARTS with a disallowed scheme, but `@supports (background:
 * url("http://evil.example/x.png"))` has the scheme buried inside a `url()`
 * token in the middle of the string, which an anchored `^scheme:` check
 * never sees. Reuses `rewriteUrls` so every `url()` anywhere in the prelude
 * gets the exact same scheme-check + resolve-or-drop treatment as a
 * declaration's value; returns undefined (drop the whole at-rule, spec's
 * "malformed CSS must not leak an external URL" default) when any url()
 * fails that check, same as a declaration with an unresolvable reference is
 * dropped rather than emitted half-sanitized.
 */
function sanitizeAtRulePrelude(prelude: string, resolveUrl: CssUrlResolver): string | undefined {
  if (DANGEROUS_VALUE_PATTERN.test(prelude) || hasDisallowedUrlScheme(prelude)) {
    return undefined;
  }
  return rewriteUrls(prelude, resolveUrl);
}

/** Sanitizes one declaration; returns undefined to drop it entirely. */
function sanitizeDeclaration(decl: DeclarationNode, resolveUrl: CssUrlResolver): DeclarationNode | undefined {
  if (!ALLOWED_PROPERTIES.has(decl.prop)) {
    return undefined;
  }
  if (DANGEROUS_VALUE_PATTERN.test(decl.value)) {
    return undefined;
  }
  if (decl.prop === "position" && decl.value.trim().toLowerCase() === "fixed") {
    return { kind: "decl", prop: decl.prop, value: "static" };
  }
  if (SIZE_GUARDED_PROPERTIES.has(decl.prop) && hasExtremeAbsoluteLength(decl.value, MAX_SIZE_PX)) {
    return undefined;
  }
  if (MARGIN_PROPERTIES.has(decl.prop) && hasExtremeAbsoluteLength(decl.value, MAX_NEGATIVE_MARGIN_PX)) {
    // hasExtremeAbsoluteLength only checks magnitude, but a large POSITIVE
    // margin is harmless for a reflowing document — only reject when at
    // least one token is actually negative.
    if (/-\s*\d/.test(decl.value)) {
      return undefined;
    }
  }
  const rewrittenValue = rewriteUrls(decl.value, resolveUrl);
  if (rewrittenValue === undefined) {
    return undefined;
  }
  return { kind: "decl", prop: decl.prop, value: rewrittenValue };
}

function sanitizeNodes(nodes: CssNode[], resolveUrl: CssUrlResolver): CssNode[] {
  const out: CssNode[] = [];
  for (const node of nodes) {
    if (node.kind === "at-decl-block") {
      // "font-face" is intentionally parsed here (so its body parses as
      // declarations, not nested rules) but is NOT in KEPT_AT_RULE_BLOCKS —
      // it is always dropped (D3), same as every other unrecognized at-rule.
      if (!KEPT_AT_RULE_BLOCKS.has(node.name)) {
        continue;
      }
      const decBlockPrelude = sanitizeAtRulePrelude(node.prelude, resolveUrl);
      if (decBlockPrelude === undefined) {
        continue;
      }
      const body = node.body
        .map((decl) => sanitizeDeclaration(decl, resolveUrl))
        .filter((decl): decl is DeclarationNode => decl !== undefined);
      if (body.length === 0) {
        continue;
      }
      out.push({ kind: "at-decl-block", name: node.name, prelude: decBlockPrelude, body });
      continue;
    }
    if (node.kind === "at-rule-list") {
      if (!KEPT_AT_RULE_BLOCKS.has(node.name)) {
        continue; // drops @import and everything else unrecognized
      }
      const listPrelude = sanitizeAtRulePrelude(node.prelude, resolveUrl);
      if (listPrelude === undefined) {
        continue;
      }
      out.push({ kind: "at-rule-list", name: node.name, prelude: listPrelude, body: sanitizeNodes(node.body, resolveUrl) });
      continue;
    }
    if (DANGEROUS_VALUE_PATTERN.test(node.selector)) {
      continue;
    }
    const body = node.body
      .map((decl) => sanitizeDeclaration(decl, resolveUrl))
      .filter((decl): decl is DeclarationNode => decl !== undefined);
    if (body.length === 0) {
      continue;
    }
    out.push({ kind: "rule", selector: node.selector, body });
  }
  return out;
}

function serializeDeclarations(decls: DeclarationNode[]): string {
  return decls.map((decl) => `  ${decl.prop}: ${decl.value};`).join("\n");
}

function serializeNodes(nodes: CssNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "at-rule-list") {
        const inner = serializeNodes(node.body);
        const prelude = node.prelude.length > 0 ? ` ${node.prelude}` : "";
        return `@${node.name}${prelude} {\n${inner}\n}`;
      }
      if (node.kind === "at-decl-block") {
        const prelude = node.prelude.length > 0 ? ` ${node.prelude}` : "";
        return `@${node.name}${prelude} {\n${serializeDeclarations(node.body)}\n}`;
      }
      return `${node.selector} {\n${serializeDeclarations(node.body)}\n}`;
    })
    .join("\n");
}

/**
 * Sanitizes a full stylesheet (spec §10.2): parses it with the tokenizer
 * above, drops every disallowed at-rule/property/value, rewrites every
 * surviving `url()` via `resolveUrl`, and re-serializes. Never throws —
 * malformed input degrades to whatever prefix the tokenizer could make
 * sense of (spec §19.1's "malformed CSS" test).
 */
export function sanitizeCss(css: string, resolveUrl: CssUrlResolver): string {
  const nodes = parseCssNodes(stripComments(css));
  return serializeNodes(sanitizeNodes(nodes, resolveUrl));
}

/**
 * Sanitizes an inline `style="..."` attribute value (spec §9's implicit
 * requirement that no sanitizer stop at the stylesheet level while leaving
 * inline styles unfiltered) — same declaration-level rules as sanitizeCss,
 * reusing its tokenizer via a throwaway rule wrapper. Returns "" when
 * nothing survives.
 */
export function sanitizeInlineStyle(styleValue: string, resolveUrl: CssUrlResolver): string {
  const declarations = parseDeclarations(stripComments(styleValue))
    .map((decl) => sanitizeDeclaration(decl, resolveUrl))
    .filter((decl): decl is DeclarationNode => decl !== undefined);
  return declarations.map((decl) => `${decl.prop}: ${decl.value};`).join(" ");
}
