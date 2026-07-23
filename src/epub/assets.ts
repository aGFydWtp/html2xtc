// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";
import { sanitizeCss } from "./css";
import type { CssUrlResolver } from "./css";

/**
 * Image handling for the self-contained HTML generator (EPUB spec §11):
 * raster images become base64 data: URLs verbatim, SVG images are parsed,
 * sanitized (script/foreignObject/event-attribute/external-reference
 * removal) and THEN base64-encoded. Shared by sanitize.ts (inline <img> in
 * spine XHTML) and html.ts (the resolved cover image).
 */

/** Allowed image media types (spec §11). */
export const ALLOWED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/**
 * URL schemes rejected everywhere a reference to EPUB-external content could
 * appear (img src, css url(), svg href/xlink:href) — spec §9's scheme
 * blocklist plus design decision D4 (an input-authored `data:` URL is
 * dropped, never trusted; only a data: URL THIS module itself produces is
 * ever allowed downstream).
 */
const DISALLOWED_URL_SCHEMES =
  /^\s*(?:https?|ftp|javascript|vbscript|file|filesystem|blob|data):/i;

/**
 * TAB/CR/LF anywhere in a URL string (review M1): the WHATWG URL parser
 * strips these before scheme detection, so `"java\tscript:alert(1)"` is
 * interpreted by a real browser as `javascript:alert(1)` even though it
 * fails a naive `^javascript:` match. Stripped before the scheme check below
 * so the same bypass can't slip past this codebase's own gate.
 */
const URL_STRIPPED_CHARS = /[\t\r\n]/g;

/** True when `raw` carries an explicit disallowed scheme (spec §9/§10.2/§18) — the shared gate every relative-reference resolver in this codebase applies before attempting archive-relative resolution. */
export function hasDisallowedUrlScheme(raw: string): boolean {
  return DISALLOWED_URL_SCHEMES.test(raw.replace(URL_STRIPPED_CHARS, ""));
}

// btoa() operates on UTF-16 code units; feeding it more than a few hundred
// KB via String.fromCharCode(...bytes) risks blowing the call-stack argument
// limit, so binary bytes are stringified in fixed-size chunks first.
const BASE64_CHUNK_SIZE = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Raster image bytes → data: URL (spec §11.1). Returns undefined for
 * anything not in ALLOWED_IMAGE_MEDIA_TYPES or for the SVG media type (SVG
 * must go through sanitizeSvgMarkup + svgMarkupToDataUrl instead — raw SVG
 * bytes are never trusted verbatim).
 */
export function rasterImageDataUrl(bytes: Uint8Array, mediaType: string): string | undefined {
  if (mediaType === "image/svg+xml" || !ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return undefined;
  }
  return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
}

/** Encodes already-sanitized SVG markup as a data: URL (spec §11.1's final "安全化後にData URL化" step). */
export function svgMarkupToDataUrl(sanitizedSvgMarkup: string): string {
  return `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(sanitizedSvgMarkup))}`;
}

/**
 * SVG elements removed outright, mirroring sanitize.ts's STRIP_SELECTOR for
 * the same reasons: `script`/`foreignObject` are spec §11.1's literal list;
 * the SMIL animation elements (`animate`/`animateTransform`/
 * `animateMotion`/`animateColor`/`set`) are review C1's fix — they can
 * retarget an ancestor's href to a `javascript:` URL at animation time,
 * bypassing the attribute-value scheme check below entirely.
 */
const SVG_STRIP_SELECTOR = "script, foreignObject, animate, animateTransform, animateMotion, animateColor, set";

/**
 * Sanitizes one SVG document's markup (spec §11.1): removes `<script>`,
 * `<foreignObject>` and SMIL animation elements, sanitizes every `<style>`
 * element's CSS the same way css.ts sanitizes an HTML stylesheet (review
 * H2 — this is the standalone-SVG path, e.g. a cover image, which has no
 * other CSS sanitization layer), strips every `on*` event attribute, and
 * resolves every href/xlink:href — an internal `#fragment` is left alone,
 * anything with a disallowed scheme is dropped, and everything else is
 * handed to `resolveReference` (bound by the caller to the SVG's own archive
 * path) so an archive-internal reference becomes a data: URL or is dropped
 * if it can't be resolved. Parsed via linkedom's HTML parser (not xml.ts's
 * XmlElement, which is read-only) so this can mutate the tree; wrapping in a
 * throwaway `<body>` mirrors src/printhtml.ts's own SVG/foreign-content
 * handling in this codebase. Returns undefined when `svgText` doesn't
 * contain a parseable `<svg>` root at all.
 */
export function sanitizeSvgMarkup(
  svgText: string,
  resolveReference: (href: string) => string | undefined,
): string | undefined {
  let svgEl: ReturnType<typeof parseHTML>["document"]["body"]["firstElementChild"];
  try {
    const { document } = parseHTML(`<!doctype html><html><body>${svgText}</body></html>`);
    svgEl = document.querySelector("svg");
  } catch {
    return undefined;
  }
  if (svgEl === null || svgEl === undefined) {
    return undefined;
  }

  for (const el of [...svgEl.querySelectorAll(SVG_STRIP_SELECTOR)]) {
    el.remove();
  }

  const cssResolver: CssUrlResolver = (rawUrl) => {
    if (hasDisallowedUrlScheme(rawUrl)) {
      return undefined;
    }
    return resolveReference(rawUrl);
  };
  for (const styleEl of [...svgEl.querySelectorAll("style")]) {
    const sanitized = sanitizeCss(styleEl.textContent ?? "", cssResolver);
    if (sanitized.trim().length > 0) {
      styleEl.textContent = sanitized;
    } else {
      styleEl.remove();
    }
  }

  for (const el of [svgEl, ...svgEl.querySelectorAll("*")]) {
    for (const name of [...el.getAttributeNames()]) {
      if (/^on/i.test(name)) {
        el.removeAttribute(name);
        continue;
      }
      if (!/(?:^|:)href$/i.test(name)) {
        continue;
      }
      const value = el.getAttribute(name);
      if (value === null) {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed.startsWith("#")) {
        continue; // internal reference within this same SVG — keep as-is
      }
      if (hasDisallowedUrlScheme(trimmed)) {
        el.removeAttribute(name);
        continue;
      }
      const resolved = resolveReference(trimmed);
      if (resolved === undefined) {
        el.removeAttribute(name);
      } else {
        el.setAttribute(name, resolved);
      }
    }
  }

  return svgEl.outerHTML;
}
