// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { repairHeadingOrphans, splitContentIntoChunks } from "../../src/aozora-fallback/split";
import type { Segment } from "../../src/aozora-fallback/split";

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

/**
 * Fixtures below mimic 神曲 02 浄火's actual structure (no `<div>`, no
 * heading elements, a giant run of `<br>`-delimited text with `<ruby>`
 * inline, and `<span class="notes">［＃改ページ］</span>` page-break notes —
 * see aozora-fallback-boundary-improvement-spec.md §3.1). The existing
 * fixtures above (`buildAozoraLikeContent`) are `<div>`/`<h4>`-based and
 * cannot reproduce the defects this suite guards against.
 */

/** A run of `n` `<br>` tags separated by `\r\n`, matching Aozora reader
 * HTML's actual serialization (`<br>\r\n<br>\r\n<br>`) — the whitespace
 * between tags is its own zero-length text node (spec §4.2). */
function brSeq(n: number): string {
  return Array(n).fill("<br />").join("\r\n");
}

/** One "line" of body text: some kana padding, an inline `<ruby>` gloss, more
 * kana, a sentence-final punctuation mark, and a single trailing `<br>` —
 * the shape of a real 浄火 line. */
function flatLine(seed: number): string {
  return `${"あ".repeat(20)}${rubyWord()}${"い".repeat(20)}それ${seed}。<br />`;
}

function flatLines(count: number, startSeed: number): string {
  let html = "";
  for (let i = 0; i < count; i++) html += flatLine(startSeed + i);
  return html;
}

function chapterTitle(n: number): string {
  return `　　　第${n}章`;
}

// Deliberately [ \t\r\n] rather than \s: \s also matches U+3000 IDEOGRAPHIC
// SPACE, which Aozora text uses for genuine indentation (e.g. chapterTitle
// below) — matching it here would strip real content, not just filler.
function tailIsOnlyBrOrWhitespace(html: string): boolean {
  return /^(?:[ \t\r\n]|<br\s*\/?>)*$/i.test(html);
}

function stripLeadingBrAndWhitespace(html: string): string {
  return html.replace(/^(?:[ \t\r\n]|<br\s*\/?>)*/i, "");
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

describe("repairHeadingOrphans", () => {
  function textSegment(textLen: number): Segment {
    return {
      html: "x".repeat(textLen),
      textLen,
      isHeading: false,
      isBr: false,
      isBlock: false,
      isPageBreak: false,
      endsSentence: false,
    };
  }

  function headingSegment(id: string): Segment {
    return {
      html: `<h4>${id}</h4>`,
      textLen: 2,
      isHeading: true,
      isBr: false,
      isBlock: false,
      isPageBreak: false,
      endsSentence: false,
    };
  }

  // Regression test for a bug where the lower bound used while walking a
  // later boundary back past an orphaned heading referenced the RAW
  // (pre-repair) value of the boundary before it, instead of that
  // boundary's own already-repaired result — so a second (or third)
  // consecutive orphaned heading right after the first boundary's original
  // position could never be walked back far enough, even though there was
  // room to do so once the first boundary had already moved.
  it("cascades the walk-back through consecutive headings that span more than one boundary", () => {
    // index: 0=text 1=H1 2=H2 3=H3 4=text 5=text
    const segments: Segment[] = [
      textSegment(20),
      headingSegment("H1"),
      headingSegment("H2"),
      headingSegment("H3"),
      textSegment(30),
      textSegment(10),
    ];
    // Raw boundaries as chosen (hypothetically) before repair: each one
    // initially lands right after one of the three consecutive headings.
    const rawBoundaries = [2, 3, 4];

    const repaired = repairHeadingOrphans(segments, rawBoundaries);

    // Correct (cascading) result: each boundary is walked back as far as
    // the ALREADY-REPAIRED previous boundary allows, not just one step off
    // its own raw position.
    expect(repaired).toEqual([1, 2, 3]);

    // The bug this guards against: with the stale (raw) lower bound, the
    // second and third boundaries could never move at all, because
    // `rawBoundaries[idx-1] + 1` already equalled their own raw value —
    // this is exactly what the buggy `boundaries[idx - 1]` reference
    // computed, so pin it down explicitly as the wrong answer.
    const buggyLowerBoundResult = rawBoundaries.map((boundary, idx) => {
      let cut = boundary;
      const lowerBound = idx === 0 ? 1 : rawBoundaries[idx - 1] + 1;
      while (cut > lowerBound && segments[cut - 1]?.isHeading === true) {
        cut -= 1;
      }
      return cut;
    });
    expect(buggyLowerBoundResult).toEqual([1, 3, 4]);
    expect(repaired).not.toEqual(buggyLowerBoundResult);

    // No boundary ever regresses past the one before it (monotonic,
    // non-empty chunks guaranteed) and never moves LATER than its raw input
    // (only ever earlier or unchanged).
    for (let i = 1; i < repaired.length; i++) {
      expect(repaired[i]).toBeGreaterThan(repaired[i - 1]);
    }
    repaired.forEach((cut, i) => expect(cut).toBeLessThanOrEqual(rawBoundaries[i]));
  });

  it("never walks a boundary below the previous (already-repaired) boundary plus one", () => {
    const segments: Segment[] = [
      textSegment(5),
      headingSegment("H1"),
      headingSegment("H2"),
      textSegment(40),
    ];
    const repaired = repairHeadingOrphans(segments, [2, 3]);
    // segments[0] is the only non-heading content before the headings, so
    // the first chunk can only ever contain that one segment — the second
    // boundary must stop at 2 (right after H1), never below it.
    expect(repaired).toEqual([1, 2]);
  });
});

describe("splitContentIntoChunks — flat (div-less, heading-less) Aozora reader HTML", () => {
  const PAGE_BREAK_KEYWORDS = ["改ページ", "改丁", "改見開き", "改段"];

  function buildPageBreakFixture(keyword: string): string {
    const before = flatLines(60, 0);
    const gap = `${brSeq(3)}<span class="notes">［＃${keyword}］</span>\r\n${brSeq(4)}`;
    const after = chapterTitle(1) + flatLines(60, 100);
    return before + gap + after;
  }

  it.each(PAGE_BREAK_KEYWORDS)(
    "recognizes ［＃%s］ as a page-break boundary (chunk cuts right after the note + trailing <br>s)",
    (keyword) => {
      const content = buildPageBreakFixture(keyword);
      const chunks = splitContentIntoChunks(content);
      const noteMarker = `［＃${keyword}］`;

      const noteChunkIdx = chunks.findIndex((c) => c.html.includes(noteMarker));
      expect(noteChunkIdx).toBeGreaterThanOrEqual(0);

      const chunkHtml = chunks[noteChunkIdx].html;
      const spanCloseIdx = chunkHtml.indexOf("</span>", chunkHtml.indexOf(noteMarker));
      expect(spanCloseIdx).toBeGreaterThanOrEqual(0);
      const tail = chunkHtml.slice(spanCloseIdx + "</span>".length);
      // Nothing but (possibly whitespace-separated) <br>s follows the note
      // within its own chunk — the note is effectively the last "real"
      // content of the chunk.
      expect(tailIsOnlyBrOrWhitespace(tail)).toBe(true);

      // The chapter title that follows the gap must open the NEXT chunk,
      // not stay behind in this one.
      const nextChunk = chunks[noteChunkIdx + 1];
      expect(nextChunk).toBeDefined();
      expect(stripLeadingBrAndWhitespace(nextChunk!.html).startsWith(chapterTitle(1))).toBe(true);
    },
  );

  it("does not treat a partial-match notes span (extra surrounding text) as a page break", () => {
    // A span.notes whose trimmed text is NOT an exact match for one of the
    // four recognized notations — e.g. a citation of the notation inside a
    // sentence — must never trigger the page-break tier.
    const before = "まえまえまえまえまえ";
    const after = "あとあとあとあとあと";
    const trap = `${before}<span class="notes">［＃改ページ］と記された行</span>${after}`;
    const content = flatLines(60, 0) + trap + flatLines(60, 100);

    const chunks = splitContentIntoChunks(content);

    // If the split correctly ignored the partial match, the text
    // immediately surrounding it was never a chosen boundary, so it stays
    // intact within a single chunk.
    const chunkWithTrap = chunks.find((c) => c.html.includes(before) && c.html.includes(after));
    expect(chunkWithTrap).toBeDefined();
  });

  it("recognizes <br>\\r\\n<br> (whitespace-separated consecutive <br>s) as a blank line worth splitting after", () => {
    // Regression test: the pre-fix scorer's `segments[i-2].isBr` check did
    // not skip the whitespace text node Aozora reader HTML inserts between
    // <br> tags, so this tier never fired on real documents (spec §4.2).
    const before = flatLines(60, 0);
    const gap = brSeq(2); // combined with `before`'s trailing single <br>, a run of 3
    const after = flatLines(60, 100);
    const content = before + gap + after;

    const chunks = splitContentIntoChunks(content);
    const gapChunkIdx = chunks.findIndex((c) => {
      const trimmed = c.html.replace(/\s+$/, "");
      return /(?:<br\s*\/?>\s*){2,}$/i.test(trimmed);
    });

    expect(gapChunkIdx).toBeGreaterThanOrEqual(0);
    expect(gapChunkIdx).toBeLessThan(chunks.length - 1);
  });

  it("does not cut mid-line: a sentence-ending punctuation mark followed by more content on the same line stays together", () => {
    // Mirrors the actual failure from spec §3.3: "…彼我に。" ends a sentence
    // but the same line continues with a <ruby> gloss and more text before
    // the real (br-terminated) line end.
    const before = flatLines(60, 0);
    const midLineTrap = `…とどむるなかれ。 八二—八四<br>彼我に。${rubyWord()}を愛する愛、その義務に缺くる。<br />`;
    const after = flatLines(60, 100);
    const content = before + midLineTrap + after;

    const chunks = splitContentIntoChunks(content);

    const trapChunk = chunks.find((c) => c.html.includes("彼我に。"));
    expect(trapChunk).toBeDefined();
    // The content immediately following the sentence-final punctuation on
    // the same line must remain in the same chunk — no boundary was
    // inserted right after "。" just because it ends a sentence.
    expect(trapChunk!.html).toContain("を愛する愛");
  });

  it("never opens a chunk with a stray <br> (blank-line runs stay attached to the end of the preceding chunk)", () => {
    const before = flatLines(60, 0);
    const gap = brSeq(3);
    const after = flatLines(60, 100);
    const content = before + gap + after;

    const chunks = splitContentIntoChunks(content);
    for (let i = 0; i < chunks.length - 1; i++) {
      const nextStart = chunks[i + 1].html.replace(/^\s+/, "");
      expect(/^<br\s*\/?>/i.test(nextStart)).toBe(false);
    }
  });
});
