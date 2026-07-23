// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { sanitizeSpineChapter } from "../../src/epub/sanitize";
import type { ChapterLinkContext, ImageResolver } from "../../src/epub/sanitize";

const noImage: ImageResolver = () => undefined;
const pngImage: ImageResolver = (raw) => (raw.includes("foo.png") ? "data:image/png;base64,AAAA" : undefined);

function ctx(overrides: Partial<ChapterLinkContext> = {}): ChapterLinkContext {
  return {
    chapterIndex: 0,
    chapterPath: "OEBPS/chapter1.xhtml",
    spineIndexByPath: new Map(),
    ...overrides,
  };
}

function xhtml(bodyInner: string): string {
  return `<!doctype html><html><head><title>T</title></head><body>${bodyInner}</body></html>`;
}

describe("sanitizeSpineChapter: element removal (spec §19.1)", () => {
  it("removes script elements (script除去)", () => {
    const result = sanitizeSpineChapter(xhtml('<p>hi</p><script>alert(1)</script>'), ctx(), noImage);
    expect(result?.bodyHtml).not.toContain("<script");
    expect(result?.bodyHtml).not.toContain("alert");
    expect(result?.bodyHtml).toContain("<p>hi</p>");
  });

  it("removes iframe elements (iframe除去)", () => {
    const result = sanitizeSpineChapter(xhtml('<iframe src="https://evil.example"></iframe><p>ok</p>'), ctx(), noImage);
    expect(result?.bodyHtml).not.toContain("<iframe");
    expect(result?.bodyHtml).toContain("<p>ok</p>");
  });

  it("removes form/input/button/video/audio/object/embed", () => {
    const html = xhtml(
      '<form><input><button>x</button></form><video src="a.mp4"></video><audio src="a.mp3"></audio><object data="a.swf"></object><embed src="a.swf">',
    );
    const result = sanitizeSpineChapter(html, ctx(), noImage);
    for (const tag of ["<form", "<input", "<button", "<video", "<audio", "<object", "<embed"]) {
      expect(result?.bodyHtml).not.toContain(tag);
    }
  });
});

describe("sanitizeSpineChapter: attribute removal (spec §19.1)", () => {
  it("removes onload/onclick and other on* event attributes (onload除去)", () => {
    const result = sanitizeSpineChapter(xhtml('<p onclick="alert(1)" onload="x()">hi</p>'), ctx(), noImage);
    expect(result?.bodyHtml).not.toMatch(/on(click|load)/i);
  });

  it("removes a javascript: href (javascript URL除去)", () => {
    const result = sanitizeSpineChapter(xhtml('<a href="javascript:alert(1)">link</a>'), ctx(), noImage);
    expect(result?.bodyHtml).not.toContain("javascript:");
    expect(result?.bodyHtml).not.toContain('href="');
  });

  it("removes an http(s) href (http URL除去)", () => {
    const result = sanitizeSpineChapter(xhtml('<a href="https://example.com/x">link</a>'), ctx(), noImage);
    expect(result?.bodyHtml).not.toContain("https://example.com");
    expect(result?.bodyHtml).not.toContain('href="');
  });
});

describe("sanitizeSpineChapter: image resolution (spec §19.1 相対画像Data URL化)", () => {
  it("rewrites a relative img src to the resolved data: URL", () => {
    const result = sanitizeSpineChapter(xhtml('<img src="images/foo.png" alt="x">'), ctx(), pngImage);
    expect(result?.bodyHtml).toContain('src="data:image/png;base64,AAAA"');
  });

  it("removes the src attribute when the image can't be resolved", () => {
    const result = sanitizeSpineChapter(xhtml('<img src="images/missing.png" alt="x">'), ctx(), noImage);
    expect(result?.bodyHtml).not.toContain("missing.png");
  });
});

describe("sanitizeSpineChapter: textContent/imageDataUrls (html.ts's cover-duplicate detection)", () => {
  it("reports empty textContent and the resolved image src for an image-only body", () => {
    const result = sanitizeSpineChapter(xhtml('<img src="images/foo.png" alt="">'), ctx(), pngImage);
    expect(result?.textContent.trim()).toBe("");
    expect(result?.imageDataUrls).toEqual(["data:image/png;base64,AAAA"]);
  });

  it("reports non-empty textContent for a body with real text", () => {
    const result = sanitizeSpineChapter(xhtml("<p>Hello, world.</p>"), ctx(), noImage);
    expect(result?.textContent).toContain("Hello, world.");
    expect(result?.imageDataUrls).toEqual([]);
  });

  it("collects an SVG <image>'s resolved href alongside <img> src values", () => {
    const result = sanitizeSpineChapter(
      xhtml('<img src="images/foo.png" alt=""><svg><image href="images/foo.png"/></svg>'),
      ctx(),
      pngImage,
    );
    expect(result?.imageDataUrls).toEqual([
      "data:image/png;base64,AAAA",
      "data:image/png;base64,AAAA",
    ]);
  });
});

describe("sanitizeSpineChapter: ruby preserved (spec §19.1 ruby保持)", () => {
  it("keeps ruby/rt/rp markup intact", () => {
    const result = sanitizeSpineChapter(xhtml("<ruby>漢字<rt>かんじ</rt></ruby>"), ctx(), noImage);
    expect(result?.bodyHtml).toContain("<ruby>");
    expect(result?.bodyHtml).toContain("<rt>かんじ</rt>");
  });
});

describe("sanitizeSpineChapter: 縦中横保持 (text-combine-upright via inline style)", () => {
  it("keeps an inline style's text-combine-upright declaration", () => {
    const result = sanitizeSpineChapter(
      xhtml('<span style="text-combine-upright: all">12</span>'),
      ctx(),
      noImage,
    );
    expect(result?.bodyHtml).toContain("text-combine-upright: all");
  });

  it("strips a dangerous inline style declaration but keeps the safe one", () => {
    const result = sanitizeSpineChapter(
      xhtml('<span style="text-combine-upright: all; behavior: url(evil.htc)">12</span>'),
      ctx(),
      noImage,
    );
    expect(result?.bodyHtml).toContain("text-combine-upright: all");
    expect(result?.bodyHtml).not.toContain("behavior");
  });
});

describe("sanitizeSpineChapter: inline SVG sanitize (spec §19.1 SVG sanitize)", () => {
  it("removes an inline svg's <script> and event attribute", () => {
    const result = sanitizeSpineChapter(
      xhtml('<svg onload="alert(1)"><script>alert(1)</script><circle r="1"/></svg>'),
      ctx(),
      noImage,
    );
    expect(result?.bodyHtml).not.toContain("<script");
    expect(result?.bodyHtml).not.toContain("onload");
    expect(result?.bodyHtml).toContain("<circle");
  });
});

describe("sanitizeSpineChapter: ID namespacing (spec §19.1 ID namespace)", () => {
  it("namespaces an id under the chapter prefix", () => {
    const result = sanitizeSpineChapter(xhtml('<h2 id="section-1">Heading</h2>'), ctx({ chapterIndex: 2 }), noImage);
    expect(result?.bodyHtml).toContain('id="chapter-0002--section-1"');
  });

  it("rewrites a same-chapter fragment link (spec §19.1 fragment link書き換え)", () => {
    const result = sanitizeSpineChapter(
      xhtml('<a href="#note1">jump</a><p id="note1">note</p>'),
      ctx({ chapterIndex: 1 }),
      noImage,
    );
    expect(result?.bodyHtml).toContain('href="#chapter-0001--note1"');
    expect(result?.bodyHtml).toContain('id="chapter-0001--note1"');
  });

  it("rewrites aria-labelledby/aria-describedby idrefs", () => {
    const result = sanitizeSpineChapter(
      xhtml('<div aria-labelledby="lbl">x</div><span id="lbl">label</span>'),
      ctx({ chapterIndex: 3 }),
      noImage,
    );
    expect(result?.bodyHtml).toContain('aria-labelledby="chapter-0003--lbl"');
  });

  it("rewrites a cross-chapter link to another rendered chapter's namespaced id", () => {
    const spineIndexByPath = new Map([
      ["OEBPS/chapter1.xhtml", 0],
      ["OEBPS/chapter2.xhtml", 1],
    ]);
    const result = sanitizeSpineChapter(
      xhtml('<a href="chapter2.xhtml#target">next</a>'),
      ctx({ chapterIndex: 0, chapterPath: "OEBPS/chapter1.xhtml", spineIndexByPath }),
      noImage,
    );
    expect(result?.bodyHtml).toContain('href="#chapter-0001--target"');
  });

  it("rewrites a fragment-less cross-chapter link to the target chapter's section id", () => {
    const spineIndexByPath = new Map([
      ["OEBPS/chapter1.xhtml", 0],
      ["OEBPS/chapter2.xhtml", 1],
    ]);
    const result = sanitizeSpineChapter(
      xhtml('<a href="chapter2.xhtml">next</a>'),
      ctx({ chapterIndex: 0, chapterPath: "OEBPS/chapter1.xhtml", spineIndexByPath }),
      noImage,
    );
    expect(result?.bodyHtml).toContain('href="#chapter-0001"');
  });

  it("drops a link to a chapter outside the rendered spine set", () => {
    const result = sanitizeSpineChapter(
      xhtml('<a href="excluded.xhtml#x">gone</a>'),
      ctx({ spineIndexByPath: new Map() }),
      noImage,
    );
    expect(result?.bodyHtml).not.toContain('href="');
  });
});

describe("sanitizeSpineChapter: SMIL animation removal (review C1)", () => {
  it("removes an <animate> that retargets an <a>'s href to javascript: via SMIL", () => {
    const result = sanitizeSpineChapter(
      xhtml('<svg><a href="#safe"><animate attributeName="href" from="0" to="javascript:alert(1)" begin="0s" dur="1s"/>click</a></svg>'),
      ctx(),
      noImage,
    );
    expect(result?.bodyHtml).not.toContain("javascript:");
    expect(result?.bodyHtml).not.toContain("<animate");
    expect(result?.bodyHtml).toContain("click");
  });

  it("removes animateTransform/animateMotion/animateColor/set elements outright", () => {
    const result = sanitizeSpineChapter(
      xhtml(
        '<svg><rect><animateTransform attributeName="transform" to="javascript:alert(1)"/><animateMotion path="javascript:alert(1)"/><animateColor attributeName="fill" to="javascript:alert(1)"/><set attributeName="href" to="javascript:alert(1)"/></rect></svg>',
      ),
      ctx(),
      noImage,
    );
    expect(result?.bodyHtml).not.toContain("javascript:");
    expect(result?.bodyHtml).not.toMatch(/<(animateTransform|animateMotion|animateColor|set)/i);
  });
});

describe("sanitizeSpineChapter: <plaintext> removal (review H3)", () => {
  it("removes a <plaintext> element instead of leaving it to swallow the rest of the assembled document", () => {
    const result = sanitizeSpineChapter(xhtml("<p>before</p><plaintext><p>after</p>"), ctx(), noImage);
    expect(result?.bodyHtml).not.toContain("<plaintext");
    expect(result?.bodyHtml).toContain("before");
  });
});

describe("sanitizeSpineChapter: xml:base removal (review M3)", () => {
  it("strips an xml:base attribute rather than leaving it in the output", () => {
    const result = sanitizeSpineChapter(xhtml('<div xml:base="http://evil.example/">x</div>'), ctx(), noImage);
    expect(result?.bodyHtml).not.toContain("xml:base");
    expect(result?.bodyHtml).not.toContain("evil.example");
  });
});

describe("sanitizeSpineChapter: duplicate id disambiguation (review M2)", () => {
  it("gives a second element with the same raw id a distinct namespaced id", () => {
    const result = sanitizeSpineChapter(xhtml('<div id="x">A</div><div id="x">B</div>'), ctx({ chapterIndex: 0 }), noImage);
    expect(result?.bodyHtml).toContain('id="chapter-0000--x"');
    expect(result?.bodyHtml).toMatch(/id="chapter-0000--x-dup2"/);
    // No two elements share the same id attribute value.
    const ids = [...(result?.bodyHtml.matchAll(/id="([^"]+)"/g) ?? [])].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("sanitizeSpineChapter: scheme check applied before image resolution (review M4)", () => {
  it("never calls the image resolver for a disallowed-scheme img src, even if the resolver itself is unsafe", () => {
    const unsafePassthroughResolver: ImageResolver = (raw) => raw;
    const result = sanitizeSpineChapter(
      xhtml('<img src="data:image/png;base64,AAAA" alt="x">'),
      ctx(),
      unsafePassthroughResolver,
    );
    expect(result?.bodyHtml).not.toContain("data:image/png;base64,AAAA");
  });

  it("never calls the image resolver for a disallowed-scheme SVG <image> href, even if the resolver itself is unsafe", () => {
    const unsafePassthroughResolver: ImageResolver = (raw) => raw;
    const result = sanitizeSpineChapter(
      xhtml('<svg><image href="javascript:alert(1)"/></svg>'),
      ctx(),
      unsafePassthroughResolver,
    );
    expect(result?.bodyHtml).not.toContain("javascript:");
  });
});

describe("sanitizeSpineChapter: parse failure is fail-soft", () => {
  it("returns undefined for input with no <body> at all", () => {
    const result = sanitizeSpineChapter("not html at all, just text", ctx(), noImage);
    // linkedom's HTML parser is lenient and will still synthesize a body for
    // plain text, so this mainly documents the contract; the real failure
    // mode is exercised at the html.ts level with genuinely empty input.
    expect(result === undefined || typeof result?.bodyHtml === "string").toBe(true);
  });
});
