// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";
import { resolveEpubRelativePath } from "./archive";
import { hasDisallowedUrlScheme } from "./assets";
import { sanitizeInlineStyle } from "./css";
import type { CssUrlResolver } from "./css";
import { XTC_CHAPTER_MARKER_CLASS } from "../../packages/aozora-text/src/index";

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
  /** `body.textContent` after stripping/sanitizing (not yet whitespace-collapsed — callers that only care about "any real text at all" should collapse/trim it themselves). Lets html.ts detect a spine item that is nothing but an image (spec: the cover-duplicate skip needs to tell "a cover-only page" apart from "a real chapter that happens to open with an image" without re-parsing bodyHtml). */
  textContent: string;
  /** Every already-resolved (data: URL or left as-is if unresolved) image reference found in the body — `<img src>` and SVG `<image href>`/`xlink:href` — in document order. Same "detect a cover-only page" purpose as textContent. */
  imageDataUrls: string[];
  /**
   * Raw ids from the caller's `markerPlan.byId` (if any) that were never
   * found among this chapter's surviving elements — see ChapterMarkerPlan's
   * own doc comment for every way an id can end up here. Empty when no
   * markerPlan was passed, or every requested id was found.
   */
  unresolvedMarkerIds: string[];
}

/** linkedom's parsed-document/element shapes, used only by
 * insertChapterMarkerSpans above (mirrors src/aozora.ts's identically-named
 * local aliases, needed for the same reason: linkedom's own exported
 * Document/Element types don't line up cleanly with what this file actually
 * calls). */
type LinkedomDocument = ReturnType<typeof parseHTML>["document"];
type LinkedomElement = NonNullable<ReturnType<LinkedomDocument["querySelector"]>>;

/**
 * XTC chapter-marker insertion plan for ONE spine item (built by
 * src/epub/html.ts's buildXtcChapterPlan from the top-level TOC entries that
 * target this chapter). Every marker string here is already a
 * formatChapterMarker() output assigned by html.ts — this module never
 * numbers chapters itself, only embeds the markers it is handed.
 */
export interface ChapterMarkerPlan {
  /**
   * Raw (pre-namespacing) id -> ordered marker strings to insert as that
   * element's first child(ren), for TOC entries whose href carried a
   * "#fragment" targeting this spine item. When more than one TOC entry
   * resolves to the SAME id — two differently-labeled TOC rows both linking
   * to the same anchor — every one of that id's markers is inserted, at the
   * SAME element, ordered so the array's first entry ends up as the
   * element's literal first child (matching TOC document order); the device
   * ends up with two menu rows that both jump to the identical page, which
   * is accepted as correct rather than worked around. Only the id's FIRST
   * DOM-order occurrence ever receives markers — this mirrors the
   * duplicate-id handling already below (a malformed source declaring the
   * same id twice keeps only the first occurrence's plain namespaced id;
   * attaching a marker to a later, shadowed duplicate would be arbitrary).
   * Any id requested here that this chapter's surviving elements never
   * contain (stripped by STRIP_SELECTOR, never existed in the source, or
   * lost to duplicate-id shadowing) is reported back via
   * SanitizedChapter.unresolvedMarkerIds — html.ts drops the corresponding
   * XTC chapter entirely rather than leaving a chapter-list entry with no
   * matching marker in the rendered document.
   */
  byId: Map<string, string[]>;
  /**
   * Ordered marker strings (same "first entry -> literal first child" rule
   * as byId above) for TOC entries whose href has NO fragment — the entry
   * points at this whole spine item, so the marker(s) go at the very start
   * of this chapter's own body, which becomes html.ts's wrapping
   * `<section>`'s first child once bodyHtml is embedded there (same visual
   * position a fragment-targeted marker on the chapter's first heading would
   * land at). Unlike byId, there is no "not found" case: this chapter's body
   * always exists whenever sanitizeSpineChapter returns a result at all, so
   * every atStart marker always gets embedded.
   */
  atStart: string[];
}

/**
 * Inline-style defense against an EPUB-authored stylesheet rule that
 * targets this class (reported bug, reproduced against a real fixture:
 * `body span.xtc-chapter-marker { color: black !important; font-size: 24px
 * !important; }` outranks a bare `.xtc-chapter-marker` class rule by
 * specificity — the CSS cascade orders same-origin, same-importance
 * declarations by specificity BEFORE source order, so "our rule is emitted
 * later in the document" (html.ts's buildFinalCss) is not the safety
 * property it looks like). An inline `style=""` attribute's declarations
 * always win the cascade over ANY selector-based declaration at the same
 * importance level, regardless of that selector's specificity (CSS
 * Cascading Level 4 §5.1) — so setting this directly on each marker span
 * closes the gap regardless of how "clever" an EPUB's own selector is,
 * including one that never even mentions this class (see css.ts's
 * XTC_CHAPTER_MARKER_SELECTOR_PATTERN doc comment for the narrower,
 * selector-text-based secondary layer this backs up). Deliberately NOT
 * reusing packages/aozora-text's XTC_CHAPTER_MARKER_CSS text verbatim (this
 * module inlines its own copy of the same declarations as a `style=""`
 * attribute instead of a class rule) — that shared constant's own doc
 * comment explains why it also now needs `!important` and opaque `white`,
 * for the same alpha=0 reason as this one.
 *
 * `color`/`-webkit-text-fill-color: white` (NOT `transparent`) for the same
 * reason as packages/aozora-text's XTC_CHAPTER_MARKER_CSS — see that
 * constant's "WHY WHITE, NOT TRANSPARENT" doc comment for the full
 * production A/B evidence. Short version: Cloudflare Browser Rendering (the
 * actual renderer behind renderSelfStyledHtmlPdf, which this module's output
 * always goes through) drops alpha=0 text from the PDF text layer entirely,
 * regardless of font-size or user-select; opaque white blends into the
 * always-white printed page (renderSelfStyledHtmlPdf never disables
 * printBackground-driven whiteness — see src/pdf.ts's PDF_OPTIONS) and
 * survives. `-webkit-text-fill-color` is set alongside `color` because an
 * EPUB stylesheet could otherwise repaint the glyphs via that property alone
 * even with `color` pinned inline.
 */
const XTC_CHAPTER_MARKER_INLINE_STYLE =
  "color:white!important;-webkit-text-fill-color:white!important;font-size:1px!important;user-select:none!important;-webkit-user-select:none!important";

/**
 * Creates one invisible XTC chapter-marker `<span>` (XTC_CHAPTER_MARKER_INLINE_STYLE
 * above makes it print-invisible even against a hostile EPUB stylesheet;
 * aria-hidden keeps a screen reader from announcing it) per `markers`
 * entry, and inserts them as `target`'s first children — iterating in
 * REVERSE so `markers[0]` ends up as the literal first child (each
 * `insertBefore(span, target.firstChild)` pushes the previous insertion one
 * slot later, so inserting the LAST marker first and the FIRST marker last
 * is what makes the final DOM order match `markers`' own order). Mirrors
 * src/aozora.ts's insertChapterMarkers (same span shape modulo the extra
 * `style` attribute, same "first child of the target element, never a
 * preceding sibling" split-safety rationale — see that function's doc
 * comment for why sibling placement is unsafe here).
 *
 * MUST be called only AFTER every pass in sanitizeSpineChapter that touches
 * a `style` attribute (the attribute-sanitization loop's `sanitizeInlineStyle`
 * branch) has already finished — sanitizeInlineStyle's job is to filter
 * UNTRUSTED, EPUB-authored style text through the same property allowlist
 * as sanitizeCss, and running this function's own TRUSTED, code-generated
 * style value through that filter risks it being reformatted or having a
 * property dropped for no benefit (every property it sets is already
 * hand-picked to be safe). sanitizeSpineChapter enforces this ordering by
 * only ever calling this function once, near its very end.
 */
function insertChapterMarkerSpans(
  document: LinkedomDocument,
  target: LinkedomElement,
  markers: readonly string[],
): void {
  for (let i = markers.length - 1; i >= 0; i--) {
    const span = document.createElement("span");
    span.setAttribute("class", XTC_CHAPTER_MARKER_CLASS);
    span.setAttribute("aria-hidden", "true");
    span.setAttribute("style", XTC_CHAPTER_MARKER_INLINE_STYLE);
    span.textContent = markers[i] ?? "";
    target.insertBefore(span, target.firstChild);
  }
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
  markerPlan?: ChapterMarkerPlan,
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
  // XTC chapter markers, fragment case: records which element is each of
  // markerPlan.byId's raw ids' FIRST DOM-order occurrence — the actual
  // marker <span> insertion is deferred to after the attribute-sanitization
  // loop below (see insertChapterMarkerSpans's own doc comment for why), so
  // this loop only decides WHICH element will receive it, keyed by the
  // still-pre-attribute-sanitization `el` reference. A later duplicate of
  // the same raw id is never recorded (checked via `isFirstOccurrence`
  // below, computed BEFORE the dup-suffix branch mutates `candidate`) — see
  // ChapterMarkerPlan's own doc comment for why only the first occurrence
  // counts. Left empty when markerPlan is undefined.
  const markerTargetByRawId = new Map<string, LinkedomElement>();
  for (const el of [...body.querySelectorAll("[id]")]) {
    const rawId = el.getAttribute("id");
    if (rawId === null || rawId.trim().length === 0) {
      continue;
    }
    let candidate = namespacedId(ctx.chapterIndex, rawId);
    const isFirstOccurrence = !seenIds.has(candidate);
    if (seenIds.has(candidate)) {
      let suffix = 2;
      while (seenIds.has(`${candidate}-dup${suffix}`)) {
        suffix++;
      }
      candidate = `${candidate}-dup${suffix}`;
    }
    seenIds.add(candidate);
    el.setAttribute("id", candidate);

    if (markerPlan !== undefined && isFirstOccurrence) {
      const markers = markerPlan.byId.get(rawId);
      if (markers !== undefined && markers.length > 0) {
        markerTargetByRawId.set(rawId, el);
      }
    }
  }
  const unresolvedMarkerIds =
    markerPlan === undefined
      ? []
      : [...markerPlan.byId.keys()].filter((id) => !markerTargetByRawId.has(id));

  for (const el of [...body.querySelectorAll("*")]) {
    for (const name of [...el.getAttributeNames()]) {
      // Every name-based comparison below runs against this normalized
      // (ASCII-lowercased) copy, never the raw `name` — linkedom preserves
      // whatever case the source markup used for an attribute name (e.g.
      // `getAttributeNames()` can return `FONT-FAMILY` verbatim), but
      // html.ts string-concatenates every sanitized chapter into one
      // document for a single real Chromium parse (see the `plaintext`
      // entry in STRIP_SELECTOR's own doc comment above), and that parse is
      // HTML5, not XML (see the xml:base branch below) — HTML5's tokenizer
      // ASCII-lowercases every attribute name it reads. Comparing against
      // `name` directly would let a same-meaning, differently-cased
      // attribute (`FONT-FAMILY`, `STYLE`, `SRCSET`, ...) slip past every
      // branch below untouched, while Chromium still treats it as the
      // lowercase attribute it normalizes to. `getAttribute`/
      // `removeAttribute`/`setAttribute` calls below still use the
      // ORIGINAL `name`, never `normalizedName` — linkedom's own accessors
      // are themselves case-sensitive against the attribute's actual stored
      // name (confirmed empirically: `getAttribute("font-family")` returns
      // null when the source had `FONT-FAMILY`), so looking the value up or
      // removing it under the normalized name would silently no-op.
      const normalizedName = name.toLowerCase();
      if (/^on/.test(normalizedName)) {
        el.removeAttribute(name);
        continue;
      }
      if (normalizedName === "style") {
        const sanitized = sanitizeInlineStyle(el.getAttribute(name) ?? "", cssResolver);
        if (sanitized.length > 0) {
          // Overwrite under the ORIGINAL `name`, not a hardcoded "style":
          // linkedom's setAttribute treats a differently-cased name as a
          // NEW attribute rather than an update to the existing one
          // (confirmed empirically), so writing back to a hardcoded
          // "style" here would leave an original `STYLE="..."` attribute
          // in place AND add a second, lowercase `style="..."` attribute —
          // exactly the double-attribute bug this comment is warning
          // against. Reusing `name` guarantees an in-place update no
          // matter what case the source used.
          el.setAttribute(name, sanitized);
        } else {
          el.removeAttribute(name);
        }
        continue;
      }
      if (normalizedName === "srcset" || normalizedName === "sizes" || normalizedName === "loading") {
        el.removeAttribute(name);
        continue;
      }
      // xml:base (review M3) can rebase every relative URL resolution
      // beneath it to an attacker-chosen origin. The emitted document is
      // parsed as HTML5 (not XML), so Chromium's own resolver ignores it —
      // but this module has no business trusting that downstream behavior
      // to stay that way, so it is stripped defensively regardless.
      if (normalizedName === "xml:base") {
        el.removeAttribute(name);
        continue;
      }
      if (normalizedName === "aria-labelledby" || normalizedName === "aria-describedby") {
        const value = el.getAttribute(name);
        if (value !== null && value.trim().length > 0) {
          el.setAttribute(name, rewriteIdrefList(value, ctx));
        }
        continue;
      }
      // <font face="..."> is a presentational hint (HTML5 §"rendering":
      // maps to an internal font-family style on that exact element), which
      // beats an inherited CSS declaration the same way a direct CSS rule
      // does — it is outside css.ts's ALLOWED_PROPERTIES choke point
      // entirely (that allowlist only ever sees stylesheets, inline
      // <style>, and inline style=""), so it is a 4th font-family injection
      // surface that needs its own removal here (a 5th, SVG's own
      // presentation attributes, is handled by the block right below). Only
      // `face` is dropped: `size` maps to font-size, which is out of scope
      // for this change.
      if (el.tagName.toLowerCase() === "font" && normalizedName === "face") {
        el.removeAttribute(name);
        continue;
      }
      // SVG presentation attributes (SVG 1.1 §"styling"): `font-family` and
      // its shorthand alias `font` (e.g. `<text font-family="Osaka">`) apply
      // directly to the element they're set on, in the CSS cascade, at the
      // same "beats an inherited declaration" strength as <font face> above
      // and as a direct CSS rule — and like <font face>, they sit outside
      // css.ts's ALLOWED_PROPERTIES choke point entirely (that allowlist
      // only ever sees stylesheets, inline <style>, and inline style="", not
      // presentation attributes). This is the 5th font-family injection
      // surface (see css.ts's ALLOWED_PROPERTIES doc comment for the running
      // list of surfaces closed so far, and why it stops short of claiming
      // that list is exhaustive). Unlike <font face>, no tag check is
      // needed: both attribute names are meaningless on non-SVG elements, so
      // dropping them by name alone, on every element, cannot remove
      // anything a plain HTML element was relying on.
      //
      // `font-size` is deliberately left alone here, same as `<font size>`
      // above and css.ts's `font-size` carve-out: it is a separate concern
      // (font *sizing*, not the font *identity* override bug this change
      // fixes) and stays out of scope.
      //
      // The other two places `font-family` could otherwise sneak in through
      // an SVG subtree are already covered elsewhere, not by this block: an
      // SVG `<style>` element's text is stripped from the body by
      // STRIP_SELECTOR above (querySelectorAll matches it regardless of
      // SVG/HTML nesting) and re-emitted only after going through css.ts's
      // sanitizeCss; and SVG elements' `style=""` attribute goes through the
      // same `normalizedName === "style"` -> sanitizeInlineStyle branch as
      // any HTML element's, a few lines above this one — neither is scoped
      // to (or skips) SVG content.
      if (normalizedName === "font-family" || normalizedName === "font") {
        el.removeAttribute(name);
        continue;
      }
      // SVG <image>'s href/xlink:href points at an actual image resource
      // (raster or nested SVG), not an in-document anchor — route it
      // through the same image resolver as <img src>, unlike <a href> or
      // <use href="#id">, which stay anchor-shaped and go through
      // resolveChapterHref below.
      if (el.tagName.toLowerCase() === "image" && /(?:^|:)href$/.test(normalizedName)) {
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
      if (CSS_URL_ATTRIBUTES.has(normalizedName)) {
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
      if (/(?:^|:)href$/.test(normalizedName)) {
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

  // XTC chapter markers: inserted here, deliberately AFTER every pass above
  // that could touch a `style` attribute (see insertChapterMarkerSpans's own
  // doc comment for why). Fragment-less (atStart) markers always insert;
  // fragment (byId) markers insert only at the target Pass 1 already found
  // — an id requested in markerPlan.byId but never recorded there (dropped
  // by STRIP_SELECTOR, never existed, or shadowed by a duplicate) simply has
  // no entry in markerTargetByRawId and is already accounted for in
  // unresolvedMarkerIds above.
  if (markerPlan !== undefined) {
    if (markerPlan.atStart.length > 0) {
      insertChapterMarkerSpans(document, body, markerPlan.atStart);
    }
    for (const [rawId, markers] of markerPlan.byId) {
      const target = markerTargetByRawId.get(rawId);
      if (target !== undefined) {
        insertChapterMarkerSpans(document, target, markers);
      }
    }
  }

  const imageDataUrls: string[] = [];
  for (const img of [...body.querySelectorAll("img")]) {
    const src = img.getAttribute("src");
    if (src !== null) {
      imageDataUrls.push(src);
    }
  }
  for (const image of [...body.querySelectorAll("image")]) {
    for (const name of image.getAttributeNames()) {
      if (/(?:^|:)href$/i.test(name)) {
        const href = image.getAttribute(name);
        if (href !== null) {
          imageDataUrls.push(href);
        }
      }
    }
  }

  return {
    bodyHtml: body.innerHTML,
    stylesheetHrefs,
    inlineStyleTexts,
    textContent: body.textContent ?? "",
    imageDataUrls,
    unresolvedMarkerIds,
  };
}
