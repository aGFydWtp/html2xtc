// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";
import { resolveEpubRelativePath } from "./archive";
import { hasDisallowedUrlScheme } from "./assets";
import { sanitizeInlineStyle } from "./css";
import type { CssUrlResolver } from "./css";

/**
 * XHTML body sanitization (EPUB spec §9) and cross-chapter ID/fragment
 * rewriting (spec §9.1, design decision D5). Parsed with linkedom's HTML
 * parser (not xml.ts's read-only XmlElement) because sanitizing requires
 * mutation (removeAttribute/remove/setAttribute) — same choice
 * src/printhtml.ts and src/text-html.ts make for markup-shaped content, and
 * safe here for the same reason the xml.ts doc comment gives for why it is
 * UNSAFE for OPF/NCX/nav: this module never touches EPUB3
 * `<meta property="...">` metadata (that stays Phase 2's job), only spine
 * item body content (headings, paragraphs, ruby, img, inline svg, ...).
 */

/**
 * Elements removed outright (spec §9's list). `link`/`style`/`title` are
 * additions beyond the spec's literal list: their content is collected
 * separately (html.ts) and re-emitted, sanitized, in the document's shared
 * `<style>` — leaving them in the body would duplicate unsanitized CSS or an
 * unexpected in-body `<title>`.
 *
 * `plaintext` is a parser-mode hazard (review H3): HTML5's tokenizer
 * switches to the PLAINTEXT state on this tag and never leaves it — there is
 * no closing tag, so everything after it (including every subsequent
 * chapter, once html.ts string-concatenates all chapters into one document
 * for a single real Chromium parse) would be swallowed as plain text.
 *
 * `animate`/`animateTransform`/`animateMotion`/`animateColor`/`set` are SVG
 * SMIL animation elements (review C1): they can retarget an ancestor's
 * `href`/`xlink:href` (or any other attribute) to a `javascript:`/`data:`
 * URL at animation time, bypassing the attribute-value scheme checks below
 * entirely (a well-known DOMPurify-class sanitizer bypass). EPUB reflow
 * content has no legitimate use for SMIL animation, so these are dropped
 * wholesale rather than attribute-filtered.
 */
const STRIP_SELECTOR = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "video",
  "audio",
  "source",
  "canvas",
  "noscript",
  "base",
  "meta[http-equiv]",
  'link[rel="preload"]',
  'link[rel="prefetch"]',
  "link",
  "style",
  "title",
  "plaintext",
  "animate",
  "animateTransform",
  "animateMotion",
  "animateColor",
  "set",
].join(", ");

/** Zero-pads a spine index into the "chapter-0001"-style namespace prefix (spec §9.1's example). */
export function chapterSectionId(chapterIndex: number): string {
  return `chapter-${String(chapterIndex).padStart(4, "0")}`;
}

/** Namespaces one raw `id` under its chapter (spec §9.1). Deterministic and pure — the same (chapterIndex, rawId) pair always produces the same output, which is what lets href rewriting target a chapter that hasn't been sanitized yet (or already was) without a second pass. */
export function namespacedId(chapterIndex: number, rawId: string): string {
  return `${chapterSectionId(chapterIndex)}--${rawId}`;
}

export interface ChapterLinkContext {
  /** This chapter's 0-based index in the FINAL rendered chapter list (not necessarily the OPF spine's own index — see html.ts's linear/TOC filtering). */
  chapterIndex: number;
  /** This chapter's archive-root-relative path (its manifest item's absolutePath). */
  chapterPath: string;
  /** Every rendered chapter's absolutePath -> its chapterIndex, built by html.ts before any chapter is sanitized. A link to a path NOT in this map (excluded/non-linear item, or something outside the spine entirely) is dropped rather than left dangling. */
  spineIndexByPath: ReadonlyMap<string, number>;
}

/** Resolves an `<img src>`/svg-`href` value to a data: URL, or undefined to drop the reference (disallowed scheme, unresolvable path, disallowed/missing media type). Bound by html.ts to the archive's entries + manifest. */
export type ImageResolver = (rawSrc: string, chapterPath: string) => string | undefined;

export interface SanitizedChapter {
  /** Already-namespaced, already-asset-resolved body content — safe to embed verbatim inside the chapter's wrapper `<section>` (spec §9.2). */
  bodyHtml: string;
  /** Raw hrefs of every `<link rel="stylesheet">` found anywhere in the document (spec §10.1) — html.ts resolves + sanitizes each against the manifest. */
  stylesheetHrefs: string[];
  /** Raw text content of every `<style>` element found anywhere in the document (spec §10.1) — html.ts sanitizes each via css.ts. */
  inlineStyleTexts: string[];
}

function isFragmentOnly(href: string): boolean {
  return href.trim().startsWith("#");
}

/** Rewrites one href-shaped value (spec §9.1): `#frag` → this chapter's namespaced id; a relative reference to another rendered chapter → that chapter's namespaced id (or bare section id with no fragment); anything else (disallowed scheme, or a target outside the rendered set) → undefined (caller drops the attribute). */
function resolveChapterHref(raw: string, ctx: ChapterLinkContext): string | undefined {
  const value = raw.trim();
  if (value.length === 0) {
    return undefined;
  }
  if (isFragmentOnly(value)) {
    const fragment = value.slice(1);
    return fragment.length === 0 ? `#${chapterSectionId(ctx.chapterIndex)}` : `#${namespacedId(ctx.chapterIndex, fragment)}`;
  }
  if (hasDisallowedUrlScheme(value)) {
    return undefined;
  }
  const hashIdx = value.indexOf("#");
  const pathPart = hashIdx === -1 ? value : value.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? "" : value.slice(hashIdx + 1);
  let targetPath: string;
  try {
    targetPath = resolveEpubRelativePath(ctx.chapterPath, pathPart);
  } catch {
    return undefined;
  }
  const targetIndex = ctx.spineIndexByPath.get(targetPath);
  if (targetIndex === undefined) {
    return undefined; // not part of the rendered document — can't link to it
  }
  return fragment.length === 0 ? `#${chapterSectionId(targetIndex)}` : `#${namespacedId(targetIndex, fragment)}`;
}

/** Rewrites a whitespace-separated idref list (aria-labelledby/aria-describedby, spec §9.1) — local (same-chapter) references only. Any token that doesn't survive is dropped from the list rather than left pointing at an un-namespaced id. */
function rewriteIdrefList(raw: string, ctx: ChapterLinkContext): string {
  return raw
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => namespacedId(ctx.chapterIndex, token))
    .join(" ");
}

const CSS_URL_ATTRIBUTES = new Set(["src"]);

/**
 * Sanitizes one spine item's XHTML (spec §9): parses it, removes every
 * forbidden element/attribute, resolves every image reference to a data:
 * URL, sanitizes inline `style=""` via css.ts, namespaces every id and
 * rewrites every fragment/local link, and returns the sanitized body
 * content plus the raw (not-yet-sanitized) stylesheet references for
 * html.ts to collect. Returns undefined when the input has no parseable
 * `<body>` at all — the caller treats that as a skippable chapter (spec's
 * general fail-soft stance: a broken chapter must not fail the whole
 * conversion) rather than aborting the job.
 */
export function sanitizeSpineChapter(
  xhtml: string,
  ctx: ChapterLinkContext,
  resolveImage: ImageResolver,
): SanitizedChapter | undefined {
  let document: ReturnType<typeof parseHTML>["document"];
  let body: (typeof document)["body"];
  try {
    ({ document } = parseHTML(xhtml));
    body = document.body;
  } catch {
    return undefined;
  }
  if (body === null || body === undefined) {
    return undefined;
  }

  const stylesheetHrefs: string[] = [];
  for (const link of [...document.querySelectorAll('link[rel~="stylesheet"]')]) {
    const href = link.getAttribute("href");
    if (href !== null && href.trim().length > 0) {
      stylesheetHrefs.push(href.trim());
    }
  }
  const inlineStyleTexts: string[] = [];
  for (const style of [...document.querySelectorAll("style")]) {
    const text = style.textContent;
    if (text !== null && text.trim().length > 0) {
      inlineStyleTexts.push(text);
    }
  }

  for (const el of [...body.querySelectorAll(STRIP_SELECTOR)]) {
    el.remove();
  }

  const cssResolver: CssUrlResolver = (rawUrl) => {
    if (hasDisallowedUrlScheme(rawUrl)) {
      return undefined;
    }
    return resolveImage(rawUrl, ctx.chapterPath);
  };

  // Pass 1: namespace every surviving id (must run before href rewriting so
  // idref-list attributes always see a namespaced target, regardless of
  // document order between the id owner and the referencing element). A
  // malformed chapter can declare the same raw id twice (review M2); the
  // first occurrence keeps the plain namespaced id, every later duplicate
  // gets a numeric suffix so no two elements in the emitted document ever
  // share an id (a duplicate id makes `#id` fragment links and
  // aria-labelledby/aria-describedby references resolve to whichever
  // element the browser happens to pick first, which is silently wrong
  // rather than merely broken).
  const seenIds = new Set<string>();
  for (const el of [...body.querySelectorAll("[id]")]) {
    const rawId = el.getAttribute("id");
    if (rawId === null || rawId.trim().length === 0) {
      continue;
    }
    let candidate = namespacedId(ctx.chapterIndex, rawId);
    if (seenIds.has(candidate)) {
      let suffix = 2;
      while (seenIds.has(`${candidate}-dup${suffix}`)) {
        suffix++;
      }
      candidate = `${candidate}-dup${suffix}`;
    }
    seenIds.add(candidate);
    el.setAttribute("id", candidate);
  }

  for (const el of [...body.querySelectorAll("*")]) {
    for (const name of [...el.getAttributeNames()]) {
      if (/^on/i.test(name)) {
        el.removeAttribute(name);
        continue;
      }
      if (name === "style") {
        const sanitized = sanitizeInlineStyle(el.getAttribute("style") ?? "", cssResolver);
        if (sanitized.length > 0) {
          el.setAttribute("style", sanitized);
        } else {
          el.removeAttribute("style");
        }
        continue;
      }
      if (name === "srcset" || name === "sizes" || name === "loading") {
        el.removeAttribute(name);
        continue;
      }
      // xml:base (review M3) can rebase every relative URL resolution
      // beneath it to an attacker-chosen origin. The emitted document is
      // parsed as HTML5 (not XML), so Chromium's own resolver ignores it —
      // but this module has no business trusting that downstream behavior
      // to stay that way, so it is stripped defensively regardless.
      if (name.toLowerCase() === "xml:base") {
        el.removeAttribute(name);
        continue;
      }
      if (name === "aria-labelledby" || name === "aria-describedby") {
        const value = el.getAttribute(name);
        if (value !== null && value.trim().length > 0) {
          el.setAttribute(name, rewriteIdrefList(value, ctx));
        }
        continue;
      }
      // SVG <image>'s href/xlink:href points at an actual image resource
      // (raster or nested SVG), not an in-document anchor — route it
      // through the same image resolver as <img src>, unlike <a href> or
      // <use href="#id">, which stay anchor-shaped and go through
      // resolveChapterHref below.
      if (el.tagName.toLowerCase() === "image" && /(?:^|:)href$/i.test(name)) {
        const raw = el.getAttribute(name);
        // Review M4: this module's own scheme gate, not just a hope that
        // every resolveImage implementation an html.ts-style caller wires
        // up remembers to call hasDisallowedUrlScheme itself first.
        const resolved =
          raw === null || hasDisallowedUrlScheme(raw.trim())
            ? undefined
            : resolveImage(raw.trim(), ctx.chapterPath);
        if (resolved !== undefined) {
          el.setAttribute(name, resolved);
        } else {
          el.removeAttribute(name);
        }
        continue;
      }
      if (CSS_URL_ATTRIBUTES.has(name)) {
        const raw = el.getAttribute(name);
        // Review M4: same defense-in-depth scheme gate as the SVG <image>
        // branch above.
        const resolved =
          raw === null || hasDisallowedUrlScheme(raw.trim())
            ? undefined
            : resolveImage(raw.trim(), ctx.chapterPath);
        if (resolved !== undefined) {
          el.setAttribute(name, resolved);
        } else if (raw !== null) {
          // Unresolvable image reference — the surviving element with a
          // dangling src is harmless (a broken-image glyph, no network
          // fetch: the sanitized document has no base URL and Browser Run
          // never resolves relative URLs against the archive), so it is
          // left in place rather than removing the whole element.
          el.removeAttribute(name);
        }
        continue;
      }
      if (/(?:^|:)href$/i.test(name)) {
        const raw = el.getAttribute(name);
        if (raw === null) {
          continue;
        }
        const rewritten = resolveChapterHref(raw, ctx);
        if (rewritten !== undefined) {
          el.setAttribute(name, rewritten);
        } else {
          el.removeAttribute(name);
        }
        continue;
      }
    }
  }

  return { bodyHtml: body.innerHTML, stylesheetHrefs, inlineStyleTexts };
}
