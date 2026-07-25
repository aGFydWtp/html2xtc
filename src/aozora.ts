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
import { formatChapterMarker, normalizeChapterName } from "../packages/aozora-text/src/chapters";
import type { XtcChapter } from "../packages/aozora-text/src/chapters";

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
 * Aozora's own XHTML class names for a 大見出し (major heading), across
 * every heading FORMAT the注記一覧/heading.html spec page documents (通常
 * "o-midashi", 同行 "dogyo-o-midashi", 窓 "mado-o-midashi") — verified
 * against https://www.aozora.gr.jp/annotation/heading.html, which is also
 * the source for the exact markup shape asserted in test/aozora.test.ts's
 * heading fixture. All three are always an `<h3>` per that page; matched by
 * exact class name (not a suffix/substring test) so this can never
 * accidentally match "ko-midashi" (小見出し, a DIFFERENT level, whose class
 * name happens to end in the same "o-midashi" substring).
 */
const MAJOR_HEADING_SELECTOR = ".o-midashi, .dogyo-o-midashi, .mado-o-midashi";

/**
 * Aozora's own XHTML class names for a 中見出し (minor heading), across the
 * same three FORMATS as MAJOR_HEADING_SELECTOR above (通常 "naka-midashi",
 * 同行 "dogyo-naka-midashi", 窓 "mado-naka-midashi") — verified against the
 * same https://www.aozora.gr.jp/annotation/heading.html page. All three are
 * always an `<h4>` per that page.
 */
const MINOR_HEADING_SELECTOR = ".naka-midashi, .dogyo-naka-midashi, .mado-naka-midashi";

/**
 * Result of insertChapterMarkers below: the extracted chapter list paired
 * with which heading level actually produced it. `level` exists so a caller
 * can log/inspect the document-wide choice (never both levels at once — see
 * determineChapterHeadingLevelForAozoraHtml's doc comment) rather than only
 * being able to infer it indirectly from `chapters`.
 */
interface AozoraChapterExtractionResult {
  chapters: XtcChapter[];
  /** 1 = 大見出し was used (present anywhere under `root`); 2 = 中見出し was
   * used (大見出し absent, 中見出し present); null = neither present, so
   * there are no chapters at all. */
  level: 1 | 2 | null;
}

/**
 * Chooses which heading level this Aozora XHTML document's chapters come
 * from — the URL-path equivalent of
 * packages/aozora-text/src/render-html.ts's determineChapterHeadingLevel,
 * same rule, same measured-data rationale (see that function's doc comment):
 * 大見出し if present anywhere, else 中見出し if present, else null (no
 * chapters). Never both at once — a document with both only chapters the 大
 * headings.
 */
function determineAozoraChapterHeadingLevel(root: LinkedomElement): 1 | 2 | null {
  if (root.querySelector(MAJOR_HEADING_SELECTOR) !== null) {
    return 1;
  }
  return root.querySelector(MINOR_HEADING_SELECTOR) !== null ? 2 : null;
}

/**
 * Inserts an invisible XTC chapter-marker span as the FIRST CHILD of every
 * heading at `root`'s chosen chapter level (determineAozoraChapterHeadingLevel
 * above) whose normalized name is non-empty (in document order), and
 * returns the corresponding {name, marker} list (src/container.ts's
 * X-Xtc-Chapters contract) alongside which level was used. Nested inside the
 * heading element itself — never as a preceding sibling — for the same
 * split-safety reason render-html.ts's renderBlock documents: Aozora's own
 * markup often wraps a heading in its own `<div class="jisage_N">` block
 * (https://www.aozora.gr.jp/annotation/heading.html's own examples), and the
 * 4-chunk timeout fallback (src/aozora-fallback/split.ts) splits at
 * top-level segment boundaries — a marker nested inside the heading stays
 * part of the same segment as the heading in every case observed in
 * practice, though not as an absolute guarantee (see render-html.ts's
 * renderBlock doc comment for the one pathological DOM shape that could
 * still separate the two, and what would actually break if it did).
 *
 * The heading's own DOM subtree is never otherwise mutated: chapter names
 * are read from a CLONE with rt/rp (ruby readings) removed — unlike
 * rubyFreeText below, which mutates h1.title/h2.author in place because
 * those elements are read once for metadata and never re-serialized into
 * contentHtml. A heading, by contrast, IS part of contentHtml, so its own
 * ruby markup must survive untouched for rendering. A heading whose
 * normalized name comes out empty (no text, an empty ruby base, or a heading
 * built only from notation this extractor doesn't resolve to text) is
 * skipped outright — neither numbered nor marked nor listed — so numbering
 * never produces a nameless {name: "", marker: ...} entry.
 */
type LinkedomDocument = ReturnType<typeof parseHTML>["document"];
/** linkedom's own Element type (not lib.dom.d.ts's global `Element`, which
 * this package's minimal type declarations don't fully implement — matching
 * rubyFreeText/metaContent below, which infer the same way rather than
 * annotating with the global DOM lib type). */
type LinkedomElement = NonNullable<ReturnType<LinkedomDocument["querySelector"]>>;

function insertChapterMarkers(
  document: LinkedomDocument,
  root: LinkedomElement,
): AozoraChapterExtractionResult {
  const level = determineAozoraChapterHeadingLevel(root);
  if (level === null) {
    return { chapters: [], level: null };
  }
  const selector = level === 1 ? MAJOR_HEADING_SELECTOR : MINOR_HEADING_SELECTOR;
  const chapters: XtcChapter[] = [];
  let chapterIndex = 0;
  for (const heading of [...root.querySelectorAll(selector)]) {
    const nameSource = heading.cloneNode(true) as LinkedomElement;
    for (const annotation of [...nameSource.querySelectorAll("rt, rp")]) {
      annotation.remove();
    }
    const name = normalizeChapterName(nameSource.textContent ?? "");
    if (name.length === 0) {
      continue;
    }
    chapterIndex++;
    const marker = formatChapterMarker(chapterIndex);
    chapters.push({ name, marker });

    const span = document.createElement("span");
    span.setAttribute("class", "xtc-chapter-marker");
    // Keeps a live DOM view (the frontend's own aozora preview injects this
    // same markup) from announcing the marker via a screen reader — never
    // consulted by Chromium's print-to-PDF, which paints from the render
    // tree, not the accessibility tree (chapters.ts's
    // renderChapterMarkerHtml doc comment covers the AST-renderer path's
    // identical reasoning for aria-hidden + the CSS's user-select: none).
    span.setAttribute("aria-hidden", "true");
    span.textContent = marker;
    heading.insertBefore(span, heading.firstChild);
  }
  return { chapters, level };
}

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

    // XTC chapter markers: inserted BEFORE reading main.innerHTML below, so
    // the invisible marker spans travel with contentHtml all the way into
    // the rendered PDF's text layer. Never touches
    // div.bibliographical_information (below) — 底本 info is never a chapter.
    const { chapters, level: chapterHeadingLevel } = insertChapterMarkers(document, main);
    // Observability for which level this document resolved to (the "戻り値
    // から判別できる" half of that requirement lives on ExtractedArticle/
    // RenderInput's chapterHeadingLevel field below; this log line covers
    // the other half for anyone reading raw Worker logs, since
    // extractAozoraArticle has no jobId in scope — only `url`).
    console.log(
      `extractAozoraArticle ${url}: chapter heading level = ${chapterHeadingLevel ?? "none"} (${chapters.length} chapter(s))`,
    );

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
      chapters,
      chapterHeadingLevel,
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
      origin: "aozora",
      chapters: article.chapters,
      chapterHeadingLevel: article.chapterHeadingLevel,
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
