// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";
import type {
  ExtractedArticle,
  RenderInput,
  SourceHtmlFetcher,
} from "./extract";
import { buildInlineFontCss } from "./fonts";
import type { FontFetcher } from "./fonts";
import { formatJstTimestamp } from "./pdf";
import { buildPrintHtml, printableText } from "./printhtml";
import type { RenderOptions } from "./types";

/**
 * Aozora Bunko preprocessing: the XHTML reader files are static,
 * hand-structured documents (Shift_JIS, CRLF, <br /> paragraphs with U+3000
 * indents, full <ruby><rb>…<rp>（</rp><rt>…</rt><rp>）</rp></ruby> markup),
 * so Readability is deliberately bypassed — its scoring/pruning can mangle
 * the ruby structure and drop the parenthesized readings into the body
 * text. The dedicated extractor below pulls exactly div.main_text (+ the
 * 底本 block) and reuses the extract-mode print pipeline
 * (sanitizeContent/buildPrintHtml) for URL absolutization, script stripping
 * and the colophon.
 *
 * This preprocessing is keyed on the URL (isAozoraBunkoUrl) only; layout
 * and font come from the request's resolved RenderOptions — an Aozora page
 * merely DEFAULTS to vertical + BIZ UDPMincho via resolveRenderOptions
 * (src/sitepresets.ts) and renders with any explicit combination.
 *
 * Everything here is fail-soft: any fetch/parse problem returns null and the
 * caller degrades to the standard extract/full pipeline, so an Aozora URL can
 * never fail a conversion the default path would have completed.
 */

// 字下げ (jisage_N: N-em indent from the line start) and 地付き (chitsuki_N:
// aligned to the line end, N em short of it) run up to well past 10 em in
// real files; 30 covers everything observed in practice, and an unmatched
// deeper class just prints without the indent. Logical properties on
// purpose: the original files carry physical margin-left/right inline
// styles that would indent the wrong axis in vertical-rl — sanitizeContent
// strips all inline styles, and these rules re-express the intent along the
// inline axis (correct in horizontal layout too). !important so the
// horizontal rule set's physical div-margin stripping cannot cancel the
// indent (both !important → the class selector wins on specificity).
const AOZORA_MAX_INDENT_EM = 30;

function aozoraIndentRules(): string {
  const rules: string[] = [];
  for (let n = 1; n <= AOZORA_MAX_INDENT_EM; n++) {
    rules.push(`.jisage_${n} { margin-inline-start: ${n}em !important; }`);
  }
  rules.push(
    `[class^="chitsuki_"], [class*=" chitsuki_"] { text-align: end !important; }`,
  );
  for (let n = 1; n <= AOZORA_MAX_INDENT_EM; n++) {
    rules.push(`.chitsuki_${n} { margin-inline-end: ${n}em !important; }`);
  }
  return rules.join("\n");
}

/**
 * Structure-specific CSS for the Aozora markup, embedded INTO the print
 * document (buildPrintHtml's documentCss) rather than injected at render
 * time: it belongs to this document's markup, not to the layout the request
 * selected — the same document renders correctly under both the vertical
 * and horizontal rule sets, and none of these class selectors can ever
 * leak onto ordinary sites.
 *
 * - 傍点/傍線 (<em class="...">) map to text-emphasis / text-decoration: the
 *   original site CSS draws them with horizontal repeat-x background
 *   images, unusable in vertical writing. text-underline-position: left
 *   puts the 傍線 on the reader-expected side vertically and behaves as
 *   auto horizontally.
 * - 斜体 (shatai): most mincho families ship no italic (BIZ UDPMincho
 *   included), degrading to synthetic oblique — accepted.
 */
export const AOZORA_DOCUMENT_CSS = `
em[class] {
  font-style: normal !important;
  background: none !important;
  padding: 0 !important;
}
em.sesame_dot, em.sesame_dot_after { text-emphasis: filled sesame; }
em.white_sesame_dot { text-emphasis: open sesame; }
em.black_circle { text-emphasis: filled circle; }
em.white_circle { text-emphasis: open circle; }
em.black_up-pointing_triangle { text-emphasis: filled triangle; }
em.white_up-pointing_triangle { text-emphasis: open triangle; }
em.bullseye { text-emphasis: open double-circle; }
em.fisheye { text-emphasis: filled double-circle; }
em.saltire { text-emphasis: "×"; }
em[class^="underline_"] {
  text-decoration: underline;
  text-underline-position: left;
}
em[class^="overline_"] { text-decoration: overline; }

/* 外字 (JIS X 0213 glyphs served as tiny PNGs): size them like a kanji. */
img.gaiji {
  width: 1em !important;
  height: 1em !important;
}

/* 挿絵: width/height ATTRIBUTES survive sanitization (only style/srcset are
   stripped) and would pin a squashed size once the layout's max-* limits
   bite, so both CSS dimensions go back to auto — the attributes still
   supply the intrinsic aspect ratio. */
img.illustration {
  width: auto !important;
  height: auto !important;
  break-inside: avoid;
}

/* 底本 (source edition) info, appended by extractAozoraArticle: small
   print on its own page, like the colophon. */
.bibliographical_information {
  break-before: page;
  font-size: 8pt !important;
}

${aozoraIndentRules()}
`;

/**
 * Pulls title/author/body out of an Aozora XHTML document. Returns null when
 * the page has no div.main_text (old-format files, index pages) — the
 * caller then falls back to the standard pipeline.
 */
export function extractAozoraArticle(
  html: string,
  url: string,
): ExtractedArticle | null {
  try {
    const { document } = parseHTML(html);
    const main = document.querySelector("div.main_text");
    if (main === null) {
      return null;
    }
    const bodyText = main.textContent ?? "";
    if (bodyText.trim().length === 0) {
      return null;
    }

    // h1.title / h2.author first (they may carry ruby: read them with rt/rp
    // removed so "徐（おもむろ）" readings don't leak into the plain text),
    // then the Dublin Core metas as fallback.
    const title =
      rubyFreeText(document, "h1.title") ?? metaContent(document, "DC.Title");
    const author =
      rubyFreeText(document, "h2.author") ??
      metaContent(document, "DC.Creator");

    // 底本 (source-edition) info, kept at the end for attribution. Optional:
    // its absence never fails the extraction.
    const biblio = document.querySelector("div.bibliographical_information");

    let contentHtml = main.innerHTML;
    let textContent = bodyText;
    if (biblio !== null && (biblio.textContent ?? "").trim().length > 0) {
      contentHtml += `<div class="bibliographical_information">${biblio.innerHTML}</div>`;
      textContent += `\n${biblio.textContent ?? ""}`;
    }

    return {
      title,
      byline: author,
      siteName: "青空文庫",
      lang: "ja",
      contentHtml,
      textContent,
    };
  } catch (error) {
    console.error(`extractAozoraArticle failed for ${url}`, error);
    return null;
  }
}

/**
 * Builds the render input for an Aozora URL: fetch (the shared fetcher
 * already handles the Shift_JIS decode via its meta-charset scan) →
 * dedicated extraction → print HTML with the structure CSS embedded, plus
 * the inlined subset of whatever font the resolved options selected. Null
 * on any failure; the caller keeps the standard pipeline as the baseline.
 */
export async function prepareAozoraRenderInput(
  target: URL,
  jobId: string,
  fetchSource: SourceHtmlFetcher,
  fontFetch: FontFetcher,
  options: RenderOptions,
): Promise<RenderInput | null> {
  try {
    const fetched = await fetchSource(target, jobId);
    if (fetched === null) {
      return null;
    }
    const article = extractAozoraArticle(
      fetched.html,
      fetched.finalUrl.toString(),
    );
    if (article === null) {
      return null;
    }
    const convertedAt = formatJstTimestamp(new Date());
    // Fail-soft like the default path: null fontCss makes renderPdfFromHtml
    // fall back to the @import variant of the print CSS.
    const fontCss = await buildInlineFontCss(
      printableText(article, fetched.finalUrl.toString(), convertedAt),
      jobId,
      fontFetch,
      options.font,
    );
    return {
      kind: "html",
      html: buildPrintHtml(
        article,
        fetched.finalUrl.toString(),
        convertedAt,
        AOZORA_DOCUMENT_CSS,
      ),
      fontCss,
    };
  } catch (error) {
    // Fail-soft: the standard pipeline is the always-works baseline.
    console.error(`[${jobId}] aozora preparation failed`, error);
    return null;
  }
}

/**
 * textContent of the first `selector` match with ruby annotations (rt) and
 * their fallback parentheses (rp) removed. The elements are mutated in
 * place; callers only read the document once, and main_text is untouched.
 */
function rubyFreeText(
  document: ReturnType<typeof parseHTML>["document"],
  selector: string,
): string | undefined {
  const el = document.querySelector(selector);
  if (el === null) {
    return undefined;
  }
  for (const annotation of [...el.querySelectorAll("rt, rp")]) {
    annotation.remove();
  }
  return nonEmpty(el.textContent);
}

function metaContent(
  document: ReturnType<typeof parseHTML>["document"],
  name: string,
): string | undefined {
  const el = document.querySelector(`meta[name="${name}"]`);
  return nonEmpty(el?.getAttribute("content"));
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
