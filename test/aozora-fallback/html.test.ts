// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { ExtractedArticle } from "../../src/extract";
import { buildPrintHtml } from "../../src/printhtml";
import { AOZORA_DOCUMENT_CSS } from "../../src/aozora";
import {
  buildAozoraFallbackChunkHtml,
  parseAozoraArticleDocument,
} from "../../src/aozora-fallback/html";
import { splitContentIntoChunks } from "../../src/aozora-fallback/split";

const SOURCE_URL = "https://www.aozora.gr.jp/cards/000148/files/789_14547.html";
const CONVERTED_AT = "2026-07-24 12:00 JST";

function buildOriginalArticleHtml(byline?: string): string {
  const article: ExtractedArticle = {
    title: "吾輩は猫である",
    byline,
    siteName: "青空文庫",
    lang: "ja",
    contentHtml:
      `<div class="jisage_1">${"あ".repeat(200)}<ruby><rb>猫</rb><rp>（</rp><rt>ねこ</rt><rp>）</rp></ruby><br /><br /></div>`.repeat(
        10,
      ) + `<div class="bibliographical_information">底本：「サンプル」</div>`,
    textContent: "",
  };
  return buildPrintHtml(article, SOURCE_URL, CONVERTED_AT, AOZORA_DOCUMENT_CSS);
}

describe("parseAozoraArticleDocument", () => {
  it("recovers title, byline and the sanitized content fragment from a real buildPrintHtml document", () => {
    const html = buildOriginalArticleHtml("夏目漱石");
    const parsed = parseAozoraArticleDocument(html);

    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe("吾輩は猫である");
    expect(parsed?.byline).toBe("夏目漱石");
    expect(parsed?.contentHtml).toContain("bibliographical_information");
    expect(parsed?.contentHtml).toContain("<ruby>");
  });

  it("leaves byline undefined when the original article had no author", () => {
    const html = buildOriginalArticleHtml(undefined);
    const parsed = parseAozoraArticleDocument(html);

    expect(parsed?.byline).toBeUndefined();
  });

  it("returns null for a document with no <h1> (structural surprise, fail-soft)", () => {
    expect(parseAozoraArticleDocument("<html><body><p>no heading here</p></body></html>")).toBeNull();
  });
});

describe("buildAozoraFallbackChunkHtml", () => {
  it("puts the title/byline header only in chunk 0 and the colophon only in chunk 3", () => {
    const original = buildOriginalArticleHtml("夏目漱石");
    const parsed = parseAozoraArticleDocument(original);
    if (parsed === null) throw new Error("expected a parsed article");
    const chunks = splitContentIntoChunks(parsed.contentHtml);

    const documents = chunks.map((chunk, index) =>
      buildAozoraFallbackChunkHtml(
        chunk.html,
        index as 0 | 1 | 2 | 3,
        { title: parsed.title, byline: parsed.byline, sourceUrl: SOURCE_URL, convertedAt: CONVERTED_AT },
      ),
    );

    for (const [index, html] of documents.entries()) {
      const { document } = parseHTML(html);
      // <title> is always present (Container reads it for X-Xtc-Title on
      // every chunk PDF), regardless of the visible h1 header toggle.
      expect(document.querySelector("title")?.textContent).toBe("吾輩は猫である");

      const h1 = document.querySelector("h1");
      const colophon = document.querySelector("#xtc-colophon");
      if (index === 0) {
        expect(h1?.textContent).toBe("吾輩は猫である");
        expect(document.body.textContent ?? "").toContain("夏目漱石");
      } else {
        expect(h1).toBeNull();
      }
      if (index === 3) {
        expect(colophon).not.toBeNull();
        expect(colophon?.textContent ?? "").toContain("吾輩は猫である");
      } else {
        expect(colophon).toBeNull();
      }
    }

    // No chunk document carries the document-level font <link>/@font-face —
    // matches buildPrintHtml's existing "NO font reference" invariant
    // (printhtml.ts's doc comment): the shared fonts.css rides via
    // addStyleTag at render time instead, never re-embedded per chunk.
    for (const html of documents) {
      expect(html).not.toMatch(/@font-face/);
    }
  });
});
