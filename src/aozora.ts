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
import { AOZORA_DOCUMENT_CSS } from "../packages/aozora-text/src/styles";

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
 * merely DEFAULTS to vertical + BIZ UDMincho via resolveRenderOptions
 * (src/sitepresets.ts) and renders with any explicit combination.
 *
 * Everything here is fail-soft: any fetch/parse problem returns null and the
 * caller degrades to the standard extract/full pipeline, so an Aozora URL can
 * never fail a conversion the default path would have completed.
 */

// AOZORA_DOCUMENT_CSS now lives in packages/aozora-text/src/styles.ts (spec
// §12.1: shared, unchanged, between this URL-extraction path and the
// AST-based TXT→HTML aozora renderer) and is re-exported here so existing
// imports of `./aozora` keep working unchanged.
export { AOZORA_DOCUMENT_CSS };

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
