// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { EpubError } from "../../src/epub/errors";
import { prepareEpubDocument, resolveMaxEpubHtmlBytes } from "../../src/epub/html";
import type { PrepareEpubDocumentContext } from "../../src/epub/html";
import { DEFAULT_EPUB_OPTIONS } from "../../src/epub-options";
import type { EpubConvertOptions } from "../../src/epub-options";
import { buildEpubZip, minimalEpub2Files, minimalEpub3Files } from "../fixtures/epub/build-epub";

const GENEROUS_LIMITS = {
  maxEntries: 5000,
  maxEntryBytes: 33_554_432,
  maxTotalUncompressedBytes: 201_326_592,
  maxHtmlBytes: 33_554_432,
};

function context(overrides: Partial<PrepareEpubDocumentContext> = {}): PrepareEpubDocumentContext {
  return {
    filename: "book.epub",
    limits: GENEROUS_LIMITS,
    now: new Date("2026-07-23T03:00:00Z"),
    ...overrides,
  };
}

function options(overrides: Partial<EpubConvertOptions> = {}): EpubConvertOptions {
  return { ...DEFAULT_EPUB_OPTIONS, ...overrides };
}

describe("prepareEpubDocument: spine order (spec §19.1 spine順)", () => {
  it("renders multi-chapter spine items in document order", () => {
    const zip = buildEpubZip({
      mimetype: "application/epub+zip",
      "META-INF/container.xml": `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      "OEBPS/content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Order Test</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c2"/><itemref idref="c1"/><itemref idref="c3"/></spine></package>`,
      "OEBPS/c1.xhtml": `<html><body><p>First-in-manifest</p></body></html>`,
      "OEBPS/c2.xhtml": `<html><body><p>First-in-spine</p></body></html>`,
      "OEBPS/c3.xhtml": `<html><body><p>Last-in-spine</p></body></html>`,
    });
    const result = prepareEpubDocument(zip, options(), context());
    const idxC2 = result.html.indexOf("First-in-spine");
    const idxC1 = result.html.indexOf("First-in-manifest");
    const idxC3 = result.html.indexOf("Last-in-spine");
    expect(idxC2).toBeGreaterThan(-1);
    expect(idxC2).toBeLessThan(idxC1);
    expect(idxC1).toBeLessThan(idxC3);
    expect(result.spineItemCount).toBe(3);
  });
});

describe("prepareEpubDocument: chapter page break (spec §19.1 章改ページ)", () => {
  it("includes the break-before rule when chapterPageBreak is true", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options({ chapterPageBreak: true }), context());
    expect(result.html).toContain("break-before: page");
  });

  it("omits the break-before rule when chapterPageBreak is false", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options({ chapterPageBreak: false }), context());
    expect(result.html).not.toContain("break-before: page");
  });
});

describe("prepareEpubDocument: cover (spec §19.1 表紙)", () => {
  function coverFiles() {
    const files = minimalEpub3Files();
    return {
      ...files,
      "OEBPS/content.opf": (files["OEBPS/content.opf"] as string).replace(
        '<manifest>',
        '<manifest><item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>',
      ),
      "OEBPS/cover.png": new Uint8Array([1, 2, 3, 4]),
    };
  }

  it("renders an epub-cover section when includeCover is true", () => {
    const zip = buildEpubZip(coverFiles());
    const result = prepareEpubDocument(zip, options({ includeCover: true }), context());
    expect(result.html).toContain('class="epub-cover"');
    expect(result.html).toContain("data:image/png;base64,");
  });

  it("omits the epub-cover section when includeCover is false", () => {
    const zip = buildEpubZip(coverFiles());
    const result = prepareEpubDocument(zip, options({ includeCover: false }), context());
    expect(result.html).not.toContain('class="epub-cover"');
  });
});

describe("prepareEpubDocument: cover-duplicate spine item skip (青空文庫-style cover page)", () => {
  function coverPageFiles() {
    const files = minimalEpub3Files();
    const opf = (files["OEBPS/content.opf"] as string)
      .replace(
        "<manifest>",
        '<manifest><item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/><item id="coverpage" href="coverpage.xhtml" media-type="application/xhtml+xml"/>',
      )
      .replace("<spine>", '<spine><itemref idref="coverpage"/>');
    return {
      ...files,
      "OEBPS/content.opf": opf,
      "OEBPS/cover.png": new Uint8Array([1, 2, 3, 4]),
      "OEBPS/coverpage.xhtml": `<html><body><img src="cover.png" alt=""/></body></html>`,
    };
  }

  it("skips a spine item that renders only the same image as the cover, recording a warning", () => {
    const zip = buildEpubZip(coverPageFiles());
    const result = prepareEpubDocument(zip, options({ includeCover: true }), context());
    // Only chapter1 (real text) renders as a spine section — the coverpage.xhtml duplicate is dropped.
    expect(result.spineItemCount).toBe(1);
    expect(result.html).toContain("Hello, world.");
    // The cover image's data: URL appears exactly once (the standalone .epub-cover
    // section), not a second time from the duplicate spine item.
    const dataUrlOccurrences = result.html.split("data:image/png;base64,").length - 1;
    expect(dataUrlOccurrences).toBe(1);
    expect(result.warnings).toContainEqual({ code: "COVER_DUPLICATE_SKIPPED" });
  });

  it("keeps a spine item that reuses the cover image but also carries its own text", () => {
    const files = coverPageFiles();
    files["OEBPS/coverpage.xhtml"] =
      `<html><body><img src="cover.png" alt=""/><p>Front matter</p></body></html>`;
    const zip = buildEpubZip(files);
    const result = prepareEpubDocument(zip, options({ includeCover: true }), context());
    expect(result.spineItemCount).toBe(2);
    expect(result.html).toContain("Front matter");
  });

  it("keeps a spine item whose only image is NOT the cover image", () => {
    const files = coverPageFiles();
    files["OEBPS/coverpage.xhtml"] = `<html><body><img src="other.png" alt=""/></body></html>`;
    const opf = (files["OEBPS/content.opf"] as string).replace(
      "<manifest>",
      '<manifest><item id="other-img" href="other.png" media-type="image/png"/>',
    );
    const zip = buildEpubZip({ ...files, "OEBPS/content.opf": opf, "OEBPS/other.png": new Uint8Array([9, 9, 9]) });
    const result = prepareEpubDocument(zip, options({ includeCover: true }), context());
    expect(result.spineItemCount).toBe(2);
  });

  it("does not skip anything when includeCover is false (no standalone cover to be a duplicate of)", () => {
    const zip = buildEpubZip(coverPageFiles());
    const result = prepareEpubDocument(zip, options({ includeCover: false }), context());
    expect(result.spineItemCount).toBe(2);
    expect(result.warnings).not.toContainEqual({ code: "COVER_DUPLICATE_SKIPPED" });
  });
});

describe("prepareEpubDocument: page margin (spec §13.1 @page, not .epub-book padding)", () => {
  it("applies marginPx via @page's margin", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options({ marginPx: 60 }), context());
    expect(result.html).toMatch(/@page\s*{\s*size:\s*528px 792px;\s*margin:\s*60px;\s*}/);
  });

  it("no longer hard-codes a competing width/min-height on html/body", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options(), context());
    expect(result.html).not.toMatch(/html,\s*body\s*{[^}]*width:\s*528px/);
    expect(result.html).not.toMatch(/html,\s*body\s*{[^}]*min-height:\s*792px/);
  });
});

describe("prepareEpubDocument: image float reset (画像のfloatをEPUB側CSSから打ち消す)", () => {
  it("neutralizes float on img/svg so a floated image never wraps following text beside it", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options(), context());
    expect(result.html).toMatch(/img,\s*svg\s*{[^}]*float:\s*none\s*!important/);
  });
});

describe("prepareEpubDocument: cover section sizing (紙面いっぱい・中央配置・改ページ)", () => {
  function coverOnlyFiles() {
    const files = minimalEpub3Files();
    return {
      ...files,
      "OEBPS/content.opf": (files["OEBPS/content.opf"] as string).replace(
        "<manifest>",
        '<manifest><item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>',
      ),
      "OEBPS/cover.png": new Uint8Array([1, 2, 3, 4]),
    };
  }

  it("sizes .epub-cover to the page's content box and forces a page break after it", () => {
    const zip = buildEpubZip(coverOnlyFiles());
    const result = prepareEpubDocument(zip, options({ marginPx: 48 }), context());
    expect(result.html).toMatch(/\.epub-cover\s*{[^}]*min-height:\s*696px/);
    expect(result.html).toMatch(/\.epub-cover\s*{[^}]*break-after:\s*page/);
  });
});

describe("prepareEpubDocument: writing-mode placement (Chromium縦書きページ分割の実測知見)", () => {
  it("applies vertical-rl only to html, never to body, when layout is explicitly vertical", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options({ layout: "vertical" }), context());
    expect(result.html).toMatch(/html\s*{\s*writing-mode:\s*vertical-rl\s*!important/);
    expect(result.html).not.toMatch(/body\s*{[^}]*writing-mode/);
  });

  it("applies horizontal-tb to .epub-book (not the html root) when layout is explicitly horizontal", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options({ layout: "horizontal" }), context());
    expect(result.html).toMatch(/\.epub-book\s*{\s*writing-mode:\s*horizontal-tb\s*!important/);
    expect(result.html).not.toMatch(/^html\s*{[^}]*writing-mode/m);
  });
});

describe("prepareEpubDocument: table of contents (spec §19.1 目次)", () => {
  it("renders a generated TOC linking to the chapter section when includeTableOfContents is true", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options({ includeTableOfContents: true }), context());
    expect(result.html).toContain('class="epub-generated-toc"');
    expect(result.html).toContain("Chapter 1");
    expect(result.html).toContain('href="#chapter-0000"');
  });

  it("omits the TOC section when includeTableOfContents is false", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options({ includeTableOfContents: false }), context());
    expect(result.html).not.toContain('class="epub-generated-toc"');
  });

  it("excludes the nav document itself from spine rendering when it is also a spine item and TOC is included", () => {
    const files = minimalEpub3Files();
    const zip = buildEpubZip({
      ...files,
      "OEBPS/content.opf": (files["OEBPS/content.opf"] as string).replace(
        "<spine>",
        '<spine><itemref idref="nav"/>',
      ),
    });
    const result = prepareEpubDocument(zip, options({ includeTableOfContents: true }), context());
    // Only the real chapter renders as a spine section; the nav page itself
    // is not double-inserted as ordinary body content.
    expect(result.spineItemCount).toBe(1);
  });
});

describe("prepareEpubDocument: horizontal layout (spec §19.1 横書き)", () => {
  it("forces horizontal-tb with !important when layout is explicitly horizontal", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options({ layout: "horizontal" }), context());
    expect(result.layout).toBe("horizontal");
    expect(result.html).toMatch(/writing-mode:\s*horizontal-tb\s*!important/);
  });
});

describe("prepareEpubDocument: vertical layout (spec §19.1 縦書き)", () => {
  it("forces vertical-rl with !important when layout is explicitly vertical", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options({ layout: "vertical" }), context());
    expect(result.layout).toBe("vertical");
    expect(result.html).toMatch(/writing-mode:\s*vertical-rl\s*!important/);
  });
});

describe("prepareEpubDocument: auto layout (spec §19.1 auto layout)", () => {
  it("defaults to horizontal when there is no direction signal", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options({ layout: "auto" }), context());
    expect(result.layout).toBe("horizontal");
  });

  it("detects vertical from page-progression-direction=rtl + Japanese language", () => {
    const files = minimalEpub3Files();
    const zip = buildEpubZip({
      ...files,
      "OEBPS/content.opf": (files["OEBPS/content.opf"] as string).replace(
        "<spine>",
        '<spine page-progression-direction="rtl">',
      ),
    });
    const result = prepareEpubDocument(zip, options({ layout: "auto" }), context());
    expect(result.layout).toBe("vertical");
  });

  it("does not switch to vertical from Japanese language alone (日本語だから自動的に縦書きにはしない)", () => {
    const zip = buildEpubZip(minimalEpub3Files()); // has dc:language=ja, no page-progression-direction
    const result = prepareEpubDocument(zip, options({ layout: "auto" }), context());
    expect(result.layout).toBe("horizontal");
  });

  it("detects vertical from the EPUB's own writing-mode CSS", () => {
    const files = minimalEpub3Files();
    const zip = buildEpubZip({
      ...files,
      "OEBPS/chapter1.xhtml": `<html><head><style>body { writing-mode: vertical-rl; }</style></head><body><p>x</p></body></html>`,
    });
    const result = prepareEpubDocument(zip, options({ layout: "auto" }), context());
    expect(result.layout).toBe("vertical");
  });
});

describe("prepareEpubDocument: colophon (spec §19.1 奥付)", () => {
  it("includes title, author, format, filename and the personal-use notice", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options(), context({ filename: "my-book.epub" }));
    expect(result.html).toContain('class="epub-colophon"');
    expect(result.html).toContain("Minimal Test Book");
    expect(result.html).toContain("Test Author");
    expect(result.html).toContain("入力形式: EPUB");
    expect(result.html).toContain("my-book.epub");
    expect(result.html).toContain("個人的利用のために作成");
    expect(result.html).toContain("Redistribution prohibited");
  });
});

describe("prepareEpubDocument: title / author (spec §19.1 title・author)", () => {
  it("returns the OPF title/author and embeds them in <title>/<meta name=author>", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    const result = prepareEpubDocument(zip, options(), context());
    expect(result.title).toBe("Minimal Test Book");
    expect(result.author).toBe("Test Author");
    expect(result.html).toContain("<title>Minimal Test Book</title>");
    expect(result.html).toContain('<meta name="author" content="Test Author">');
  });

  it("works for an EPUB2 (NCX) book too", () => {
    const zip = buildEpubZip(minimalEpub2Files());
    const result = prepareEpubDocument(zip, options(), context());
    expect(result.title).toBe("Minimal EPUB2 Book");
    expect(result.author).toBe("EPUB2 Author");
    expect(result.spineItemCount).toBe(1);
  });
});

describe("prepareEpubDocument: HTML size limit (spec §19.1 HTMLサイズ制限, design decision D11)", () => {
  it("throws a deterministic HTML_TOO_LARGE EpubError when the generated document exceeds maxHtmlBytes", () => {
    const zip = buildEpubZip(minimalEpub3Files());
    expect(() =>
      prepareEpubDocument(zip, options(), context({ limits: { ...GENEROUS_LIMITS, maxHtmlBytes: 100 } })),
    ).toThrow(EpubError);
    try {
      prepareEpubDocument(zip, options(), context({ limits: { ...GENEROUS_LIMITS, maxHtmlBytes: 100 } }));
      expect.unreachable();
    } catch (error) {
      expect((error as EpubError).code).toBe("HTML_TOO_LARGE");
      expect((error as EpubError).deterministic).toBe(true);
    }
  });
});

describe("prepareEpubDocument: fixed layout rejection", () => {
  it("throws FIXED_LAYOUT_UNSUPPORTED for a pre-paginated EPUB", () => {
    const files = minimalEpub3Files();
    const zip = buildEpubZip({
      ...files,
      "OEBPS/content.opf": (files["OEBPS/content.opf"] as string).replace(
        "<dc:title>",
        '<meta property="rendition:layout">pre-paginated</meta><dc:title>',
      ),
    });
    expect(() => prepareEpubDocument(zip, options(), context())).toThrow(EpubError);
    try {
      prepareEpubDocument(zip, options(), context());
      expect.unreachable();
    } catch (error) {
      expect((error as EpubError).code).toBe("FIXED_LAYOUT_UNSUPPORTED");
    }
  });
});

describe("prepareEpubDocument: image count", () => {
  it("counts unique embedded images", () => {
    const files = minimalEpub3Files();
    const zip = buildEpubZip({
      ...files,
      "OEBPS/content.opf": (files["OEBPS/content.opf"] as string).replace(
        "<manifest>",
        '<manifest><item id="img1" href="a.png" media-type="image/png"/>',
      ),
      "OEBPS/chapter1.xhtml": `<html><body><img src="a.png"><img src="a.png"></body></html>`,
      "OEBPS/a.png": new Uint8Array([1, 2, 3]),
    });
    const result = prepareEpubDocument(zip, options(), context());
    expect(result.imageCount).toBe(1); // same path referenced twice — counted once
  });
});

describe("resolveMaxEpubHtmlBytes", () => {
  it("returns the configured value when valid", () => {
    expect(resolveMaxEpubHtmlBytes({ MAX_EPUB_HTML_BYTES: "12345" })).toBe(12345);
  });

  it("falls back to the 32 MiB default when unset/invalid", () => {
    expect(resolveMaxEpubHtmlBytes({})).toBe(33_554_432);
    expect(resolveMaxEpubHtmlBytes({ MAX_EPUB_HTML_BYTES: "not-a-number" })).toBe(33_554_432);
    expect(resolveMaxEpubHtmlBytes({ MAX_EPUB_HTML_BYTES: "-5" })).toBe(33_554_432);
  });
});
