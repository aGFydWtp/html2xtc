// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Deterministic web-font inlining for extract mode.
 *
 * Background (font investigation, 2026-07-19): serving the extract print HTML
 * with a <link> to Google Fonts turned out to be probabilistic — the PDF
 * capture does not wait for font downloads (networkidle2's "≤2 connections
 * for 500ms" condition passes while the serial CSS→woff2 fetch is still in
 * flight), and the page UA ("xtc-converter/1.0") makes fonts.googleapis.com
 * serve a single ~4.4MB full TTF instead of subsets. Result: BIZ UDPGothic
 * was never applied; every capture showed the swap fallback — which on
 * Browser Run is WenQuanYi Zen Hei (Chinese glyphs), as the environment has
 * no Japanese font. (The other half of the fix is the top-level font-family
 * rule in pdf.ts: inside @media print the lazy font loader never fires.)
 *
 * Fix: the Worker fetches the font at document-build time and embeds it as
 * base64 data: URLs, removing the render-time network dependency entirely.
 *
 * Strategy: css2's `text=` parameter returns subsets of exactly the requested
 * characters, per weight, WITH unicode-range (verified 2026-07-19: 1,100
 * unique chars over 3 chunks → 6 faces, ~224KB raw woff2 for both weights,
 * ~300KB as base64). The used character set is chunked into URL-length-safe
 * requests; every returned @font-face is inlined with its woff2 as base64.
 * The unicode-range on each face keeps the chunks from overriding each other
 * in the cascade (faces of the same family/weight without ranges would).
 *
 * Everything here is fail-soft: any fetch error, unexpected response shape or
 * size-cap breach returns null, and the caller keeps the current <link>
 * behavior (worst case: Noto rendering, never a failed job).
 */

/**
 * Default body family (the pre-options behavior). The request's `font`
 * option may name any Google Fonts family; resolveRenderOptions
 * (src/sitepresets.ts) falls back to this — or to BIZ UDMincho for Aozora
 * Bunko URLs — when the option is absent or fails sanitization.
 */
export const DEFAULT_FONT_FAMILY = "BIZ UDPGothic";

/**
 * Families requested at 400;700. css2 rejects the whole request when ANY
 * listed weight is missing from the family, so the dual-weight axis is only
 * safe for families whose weights are known. Arbitrary user-supplied
 * families are requested without a weight axis instead — css2 then serves
 * regular (400) only, which every family has; bold text falls back to
 * synthetic bold. Both defaults ship exactly 400/700 on Google Fonts.
 */
const DUAL_WEIGHT_FAMILIES = new Set(["BIZ UDPGothic", "BIZ UDMincho"]);

/**
 * css2 stylesheet URL for `family`; spaces become + per the css2 URL
 * convention. Callers must pass a sanitizeFontFamily()-clean name — the
 * character allowlist is what keeps this interpolation URL-safe.
 */
export function fontCssEndpoint(family: string): string {
  const axis = DUAL_WEIGHT_FAMILIES.has(family) ? ":wght@400;700" : "";
  return `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}${axis}&display=swap`;
}

/**
 * Validates a user-supplied Google Fonts family name; undefined for
 * anything unusable (the caller then falls back to the default family).
 * The name gets embedded in a quoted CSS font-family declaration AND in the
 * css2 request URL, so this is injection control, not just tidiness: ASCII
 * letters/digits/spaces/hyphens only (every Google Fonts family name fits),
 * must start with a letter or digit, 64 chars max. Notably excluded:
 * quotes, semicolons, braces, parentheses, slashes, "&", "#" and non-ASCII.
 */
export function sanitizeFontFamily(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * Sent to fonts.googleapis.com / fonts.gstatic.com ONLY. Google Fonts keys
 * its response format on the UA: unknown UAs (like RENDER_USER_AGENT) get a
 * full TTF, Chrome-like UAs get woff2 subsets. The page-facing identity of
 * this service (RENDER_USER_AGENT on all target-site requests) is unchanged.
 */
const FONT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FONT_FETCH_TIMEOUT_MS = 10_000;

// 450 chars per text= request keeps the URL at ~4KB (each CJK char percent-
// encodes to 9 bytes), comfortably under the ~8KB URL limits common to CDNs.
const CHARS_PER_CHUNK = 450;

// 8 chunks = 3,600 unique chars, beyond JIS level 1 (2,965 kanji) plus kana/
// ASCII — practically every real article fits. Documents richer than that
// get their first 3,600 unique chars inlined; the remainder falls back per
// glyph to Noto via the font-family stack (logged below).
const MAX_CHUNKS = 8;

// Cap on total inlined woff2 bytes (pre-base64). Typical articles measure
// ~250KB for both weights; the cap only guards against unexpected upstream
// responses (e.g. the full-TTF answer served to non-Chrome UAs).
const MAX_INLINE_FONT_BYTES = 2 * 1024 * 1024;

/** Injection point for tests, mirroring extract.ts's SourceHtmlFetcher. */
export type FontFetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

interface ParsedFontFace {
  fontStyle: string;
  fontWeight: string;
  woff2Url: string;
  unicodeRange: string | null;
}

/**
 * Builds a CSS string of @font-face rules covering every character in `text`,
 * with the woff2 data embedded as base64 data: URLs. Returns null on any
 * problem (fail-soft; the caller falls back to the <link> reference).
 */
export async function buildInlineFontCss(
  text: string,
  jobId: string,
  fetchFn: FontFetcher = fetch,
  family: string = DEFAULT_FONT_FAMILY,
): Promise<string | null> {
  try {
    const chars = uniqueChars(text);
    if (chars.length === 0) {
      return null;
    }

    const chunks: string[] = [];
    for (
      let i = 0;
      i < chars.length && chunks.length < MAX_CHUNKS;
      i += CHARS_PER_CHUNK
    ) {
      chunks.push(chars.slice(i, i + CHARS_PER_CHUNK).join(""));
    }
    const covered = Math.min(chars.length, MAX_CHUNKS * CHARS_PER_CHUNK);
    if (covered < chars.length) {
      console.log(
        `[${jobId}] font subset capped at ${covered}/${chars.length} unique chars; the rest render via the fallback stack`,
      );
    }

    const cssChunks = await Promise.all(
      chunks.map((chunk) => fetchFontCss(chunk, fetchFn, family)),
    );
    const faces = cssChunks.flatMap((css) => parseFontFaces(css));
    if (faces.length === 0) {
      throw new Error("css2 response contained no usable @font-face rules");
    }

    const fonts = await Promise.all(
      faces.map((face) => fetchWoff2(face.woff2Url, fetchFn)),
    );
    const totalBytes = fonts.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    if (totalBytes > MAX_INLINE_FONT_BYTES) {
      throw new Error(
        `inlined font size ${totalBytes} exceeds the ${MAX_INLINE_FONT_BYTES} byte cap`,
      );
    }

    const css = faces
      .map((face, i) => inlineFontFace(face, fonts[i] as Uint8Array, family))
      .join("\n");
    console.log(
      `[${jobId}] font: inline (${family}, ${faces.length} faces, ${Math.round(totalBytes / 1024)}KB woff2, ${covered} unique chars)`,
    );
    return css;
  } catch (error) {
    // Fail-soft: a missing web font is an accepted degradation (fallback
    // rendering — WenQuanYi Zen Hei on Browser Run), a failed conversion is
    // not — same stance as the colophon script and the extraction pipeline.
    console.error(`[${jobId}] font: fail-soft to remote-font fallback`, error);
    return null;
  }
}

/**
 * Unique code points of `text`, minus control characters (line breaks, tabs,
 * DEL — no glyph to subset). U+0020 space is kept: its advance width matters
 * for Latin runs. Written as code-point checks, not a regex character class,
 * so the source file never contains raw control characters.
 */
function uniqueChars(text: string): string[] {
  return [...new Set(text)].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  });
}

async function fetchFontCss(
  chunk: string,
  fetchFn: FontFetcher,
  family: string,
): Promise<string> {
  const url = `${fontCssEndpoint(family)}&text=${encodeURIComponent(chunk)}`;
  const response = await fetchFn(url, {
    headers: { "User-Agent": FONT_FETCH_USER_AGENT },
    signal: AbortSignal.timeout(FONT_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`font css fetch failed with status ${response.status}`);
  }
  return response.text();
}

async function fetchWoff2(
  url: string,
  fetchFn: FontFetcher,
): Promise<Uint8Array> {
  const response = await fetchFn(url, {
    headers: { "User-Agent": FONT_FETCH_USER_AGENT },
    signal: AbortSignal.timeout(FONT_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`woff2 fetch failed with status ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Extracts the fields this module re-emits from each @font-face block.
 * Throws on blocks without a fonts.gstatic.com woff2 src: an unexpected
 * response shape must abort the whole inlining (fail-soft in the caller),
 * not silently produce a font with holes.
 */
function parseFontFaces(css: string): ParsedFontFace[] {
  const faces: ParsedFontFace[] = [];
  for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const woff2Url = block.match(
      /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)\s*format\(['"]woff2['"]\)/,
    )?.[1];
    if (woff2Url === undefined) {
      throw new Error("css2 @font-face without a gstatic woff2 src");
    }
    faces.push({
      fontStyle: block.match(/font-style:\s*([^;]+);/)?.[1] ?? "normal",
      fontWeight: block.match(/font-weight:\s*([^;]+);/)?.[1] ?? "400",
      woff2Url,
      unicodeRange: block.match(/unicode-range:\s*([^;]+);/)?.[1] ?? null,
    });
  }
  return faces;
}

function inlineFontFace(
  face: ParsedFontFace,
  bytes: Uint8Array,
  family: string,
): string {
  const range =
    face.unicodeRange === null ? "" : `unicode-range:${face.unicodeRange};`;
  return (
    `@font-face{font-family:'${family}';font-style:${face.fontStyle};` +
    `font-weight:${face.fontWeight};font-display:swap;` +
    `src:url(data:font/woff2;base64,${base64Encode(bytes)}) format('woff2');${range}}`
  );
}

/** btoa over a byte array, chunked so String.fromCharCode never overflows. */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}
