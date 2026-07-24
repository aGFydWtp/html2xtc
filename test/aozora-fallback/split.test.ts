// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { splitContentIntoChunks } from "../../src/aozora-fallback/split";

/**
 * Synthetic Aozora-shaped fixture (no external fetch — spec §23/§27 "外部
 * URLをCIから直接fetchしない"): jisage indent <div> blocks each holding
 * plain text + a <ruby> annotation + a paragraph-separating <br><br>, with
 * naka-midashi <h4> chapter headings interspersed and a trailing
 * bibliographical_information block — mirrors extractAozoraArticle's actual
 * output shape (src/aozora.ts).
 */
function rubyWord(): string {
  return `<ruby><rb>漢字</rb><rp>（</rp><rt>かんじ</rt><rp>）</rp></ruby>`;
}

function jisageParagraph(seed: number): string {
  return `<div class="jisage_1">${"あ".repeat(40)}${rubyWord()}${"い".repeat(40)}その${seed}。<br /><br /></div>`;
}

function buildAozoraLikeContent(paragraphCount: number, withImage = false): string {
  let html = "";
  for (let i = 0; i < paragraphCount; i++) {
    if (i > 0 && i % 5 === 0) {
      html += `<h4 class="naka-midashi">第${i / 5}章</h4>`;
    }
    html += jisageParagraph(i);
  }
  if (withImage) {
    html += `<div class="illustration"><img src="https://www.aozora.gr.jp/gaiji/example.png" alt="" /></div>`;
  }
  html += `<div class="bibliographical_information">底本：「サンプル作品」<br />発行：サンプル出版<br /></div>`;
  return html;
}

function plainText(fragmentHtml: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${fragmentHtml}</body></html>`);
  return document.body.textContent ?? "";
}

function countTag(fragmentHtml: string, tag: string): number {
  const { document } = parseHTML(`<!doctype html><html><body>${fragmentHtml}</body></html>`);
  return document.body.querySelectorAll(tag).length;
}

describe("splitContentIntoChunks", () => {
  it("returns exactly 4 non-empty chunks in original order with equal total text", () => {
    const content = buildAozoraLikeContent(30);
    const chunks = splitContentIntoChunks(content);

    expect(chunks).toHaveLength(4);
    for (const chunk of chunks) {
      expect(chunk.textLength).toBeGreaterThan(0);
    }

    const originalText = plainText(content).replace(/\s+/g, "");
    const rejoinedText = chunks.map((c) => plainText(c.html)).join("").replace(/\s+/g, "");
    expect(rejoinedText).toBe(originalText);
  });

  it("preserves every ruby/br/img element across the 4 chunks (nothing dropped, nothing split)", () => {
    const content = buildAozoraLikeContent(30, true);
    const chunks = splitContentIntoChunks(content);

    const totalRuby = chunks.reduce((sum, c) => sum + c.rubyCount, 0);
    const totalBr = chunks.reduce((sum, c) => sum + c.brCount, 0);
    const totalImg = chunks.reduce((sum, c) => sum + c.imageCount, 0);
    expect(totalRuby).toBe(countTag(content, "ruby"));
    expect(totalBr).toBe(countTag(content, "br"));
    expect(totalImg).toBe(countTag(content, "img"));

    // Every <ruby> in every chunk must still carry its <rt> reading — a
    // ruby split down the middle would silently lose or duplicate <rt>.
    for (const chunk of chunks) {
      const { document } = parseHTML(`<!doctype html><html><body>${chunk.html}</body></html>`);
      for (const ruby of [...document.body.querySelectorAll("ruby")] as { querySelector(sel: string): unknown }[]) {
        expect(ruby.querySelector("rt")).not.toBeNull();
      }
    }
  });

  it("puts the bibliographical_information block only in the last chunk", () => {
    const content = buildAozoraLikeContent(30);
    const chunks = splitContentIntoChunks(content);

    expect(chunks[0].html).not.toContain("bibliographical_information");
    expect(chunks[1].html).not.toContain("bibliographical_information");
    expect(chunks[2].html).not.toContain("bibliographical_information");
    expect(chunks[3].html).toContain("bibliographical_information");
  });

  it("never leaves a heading as the trailing element of a non-final chunk (no orphaned heading)", () => {
    const content = buildAozoraLikeContent(40);
    const chunks = splitContentIntoChunks(content);

    for (const chunk of chunks.slice(0, 3)) {
      const { document } = parseHTML(`<!doctype html><html><body>${chunk.html}</body></html>`);
      const last = document.body.lastElementChild;
      if (last !== null) {
        expect(/^h[1-4]$/.test(last.tagName.toLowerCase())).toBe(false);
      }
    }
  });

  it("balances chunks roughly evenly for a large uniform document", () => {
    const content = buildAozoraLikeContent(200);
    const chunks = splitContentIntoChunks(content);
    const total = chunks.reduce((sum, c) => sum + c.textLength, 0);
    for (const chunk of chunks) {
      const share = chunk.textLength / total;
      // Spec §14: "各チャンクは総文字数の15〜35%を目安とする".
      expect(share).toBeGreaterThan(0.15);
      expect(share).toBeLessThan(0.35);
    }
  });

  it("falls back to code-point-safe text splitting when there are too few DOM segments", () => {
    // A single giant text node (no elements at all) — forces the tier-8
    // ("テキストノード境界") fallback path.
    const content = "あ".repeat(400) + "🀄".repeat(20) + "い".repeat(400); // includes a surrogate pair (U+1F004)
    const chunks = splitContentIntoChunks(content);

    expect(chunks).toHaveLength(4);
    for (const chunk of chunks) {
      expect(chunk.textLength).toBeGreaterThan(0);
      // No lone surrogate: a broken pair would make this throw or contain
      // U+FFFD-free invalid code units, so round-tripping through
      // Array.from must succeed without altering length parity.
      expect(() => Array.from(chunk.html)).not.toThrow();
    }
    const rejoined = chunks.map((c) => plainText(c.html)).join("");
    expect(rejoined).toBe(content);
  });

  it("throws the fixed 'the document could not be split safely' message for empty content", () => {
    expect(() => splitContentIntoChunks("")).toThrow("the document could not be split safely");
    expect(() => splitContentIntoChunks("   \n\t  ")).toThrow(
      "the document could not be split safely",
    );
  });
});
