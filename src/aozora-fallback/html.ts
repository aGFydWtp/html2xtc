// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";
import type { ExtractedArticle } from "../extract";
import { buildPrintHtml } from "../printhtml";
import { AOZORA_DOCUMENT_CSS } from "../aozora";
import type { AozoraFallbackChunkIndex } from "./keys";

/** Fixed per extractAozoraArticle (src/aozora.ts) — every fallback chunk
 * document uses the same site name as the original single-document render. */
const AOZORA_SITE_NAME = "青空文庫";

/**
 * Assembles one chunk's full, self-contained print HTML document (spec
 * §15) by delegating to buildPrintHtml with PrintDocumentOptions: only chunk
 * 0 gets the title/byline header, only chunk 3 gets the generated colophon.
 * The 底本 (source-edition) block needs no toggle here — it travels inside
 * `chunkHtml` itself when the DOM split happened to place it in this chunk
 * (naturally chunk 3, since extractAozoraArticle appends it at the end of
 * the original content — see PrintDocumentOptions's doc comment in
 * printhtml.ts).
 *
 * `chunkHtml` is ALREADY sanitized (it is a slice of the original
 * sanitizeContent() output, reassembled from whole DOM nodes — see
 * split.ts). Re-running sanitizeContent via buildPrintHtml on it is
 * idempotent for this content: no script/style survives to re-strip, every
 * img src is already an absolute http(s) URL (resolves to itself), and the
 * duplicate-heading check only matches h1/h2 — Aozora's own structural
 * headings inside main_text are h3-h5 (pdf.ts's verticalPrintRules doc
 * comment), so it can never collide with the document title.
 */
export function buildAozoraFallbackChunkHtml(
  chunkHtml: string,
  index: AozoraFallbackChunkIndex,
  meta: { title: string; byline?: string; sourceUrl: string; convertedAt: string },
): string {
  const article: ExtractedArticle = {
    title: meta.title,
    byline: meta.byline,
    siteName: AOZORA_SITE_NAME,
    lang: "ja",
    contentHtml: chunkHtml,
    // Not read by buildPrintHtml; the shared fonts.css was already subset
    // from the WHOLE document's text at extract-content time (spec §15's
    // "フォントCSSは文書全体で1回だけ生成"), never regenerated per chunk.
    textContent: "",
  };
  return buildPrintHtml(article, meta.sourceUrl, meta.convertedAt, AOZORA_DOCUMENT_CSS, {
    includeDocumentHeader: index === 0,
    includeBibliographicalInformation: true,
    includeColophon: index === 3,
  });
}

/** title/byline + the sanitized content-div innerHTML pulled back out of a
 * previously assembled Aozora print document (see html.ts's
 * buildAozoraFallbackChunkHtml / src/aozora.ts's prepareAozoraRenderInput —
 * both go through buildPrintHtml, which this is the structural inverse of). */
export interface ParsedAozoraArticleDocument {
  title: string;
  byline?: string;
  /** Sanitized content fragment — includes the 底本 block at its end when
   * the original extraction found one (extractAozoraArticle, src/aozora.ts). */
  contentHtml: string;
}

/**
 * Reconstructs {title, byline, contentHtml} from the stored article.html
 * (prepare-aozora-fallback's step 2, "DOM復元" — spec §16.2). Relies on
 * buildPrintHtml's fixed structure: body children are, in order,
 * [h1, (optional source-line div), content div, #xtc-colophon div] — the
 * content div is identified as the colophon's previous sibling (or the
 * body's last element when no colophon is present, defensively) rather than
 * by position count, so it stays correct even if a future buildPrintHtml
 * change adds/removes an optional piece elsewhere. Returns null (fail-soft,
 * like every other Aozora extraction step) on any structural surprise — the
 * caller turns that into the fixed "the document could not be split safely"
 * NonRetryableError.
 */
export function parseAozoraArticleDocument(articleHtml: string): ParsedAozoraArticleDocument | null {
  try {
    const { document } = parseHTML(articleHtml);
    const h1 = document.querySelector("h1");
    const title = h1?.textContent?.trim();
    if (h1 === null || title === undefined || title.length === 0) {
      return null;
    }
    const colophon = document.querySelector("#xtc-colophon");
    const contentDiv = colophon?.previousElementSibling ?? document.body.lastElementChild;
    if (contentDiv === null || contentDiv === h1) {
      return null;
    }
    let byline: string | undefined;
    const between = contentDiv.previousElementSibling;
    if (between !== null && between !== h1) {
      const text = (between.textContent ?? "").trim();
      if (text.length > 0 && text !== AOZORA_SITE_NAME) {
        byline = text.startsWith(`${AOZORA_SITE_NAME} · `)
          ? text.slice(`${AOZORA_SITE_NAME} · `.length)
          : text;
      }
    }
    return { title, byline, contentHtml: contentDiv.innerHTML };
  } catch (error) {
    console.error("parseAozoraArticleDocument failed", error);
    return null;
  }
}
