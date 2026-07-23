// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { locateNavigationDocument } from "../../src/epub/navigation";
import { parsePackageDocument, resolveEpubAuthor, resolveEpubTitle } from "../../src/epub/opf";
import { EpubError } from "../../src/epub/errors";

const OPF_PATH = "OEBPS/content.opf";

function entriesWithOpf(xml: string): Map<string, Uint8Array> {
  return new Map([[OPF_PATH, new TextEncoder().encode(xml)]]);
}

const EPUB3_OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>My Book</dc:title>
    <dc:creator>Author One</dc:creator>
    <dc:creator>Author Two</dc:creator>
    <dc:language>ja</dc:language>
    <meta property="rendition:layout">reflowable</meta>
  </metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2" linear="no"/>
  </spine>
</package>`;

describe("parsePackageDocument: EPUB3 happy path (spec §19.1 EPUB3, title/creator, manifest, spine, linear=no, cover, nav)", () => {
  const pkg = parsePackageDocument(entriesWithOpf(EPUB3_OPF), OPF_PATH);

  it("parses version", () => {
    expect(pkg.version).toBe("3.0");
  });

  it("parses title and joins creators with / ", () => {
    expect(pkg.metadata.title).toBe("My Book");
    expect(pkg.metadata.author).toBe("Author One / Author Two");
  });

  it("parses the manifest, resolving hrefs relative to the OPF directory", () => {
    expect(pkg.manifest.get("c1")?.absolutePath).toBe("OEBPS/chapter1.xhtml");
    expect(pkg.manifest.get("cover-img")?.properties.has("cover-image")).toBe(true);
  });

  it("parses the spine in document order, preserving linear=no", () => {
    expect(pkg.spine.map((item) => item.idref)).toEqual(["c1", "c2"]);
    expect(pkg.spine[0]?.linear).toBe(true);
    expect(pkg.spine[1]?.linear).toBe(false);
  });

  it("resolves the cover via manifest properties=cover-image (spec §11.3 priority 1)", () => {
    expect(pkg.coverImagePath).toBe("OEBPS/images/cover.jpg");
  });

  it("locates the EPUB3 nav document via manifest properties=nav", () => {
    expect(locateNavigationDocument(pkg)).toEqual({ path: "OEBPS/nav.xhtml", kind: "nav" });
  });

  it("is not Fixed Layout", () => {
    expect(pkg.isFixedLayout).toBe(false);
  });
});

const EPUB2_OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>EPUB2 Book</dc:title>
    <dc:creator>Sole Author</dc:creator>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-img" href="cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
  </spine>
</package>`;

describe("parsePackageDocument: EPUB2 happy path (spec §19.1 EPUB2, NCX)", () => {
  const pkg = parsePackageDocument(entriesWithOpf(EPUB2_OPF), OPF_PATH);

  it("parses version 2.0", () => {
    expect(pkg.version).toBe("2.0");
  });

  it("resolves the cover via EPUB2 <meta name=cover> (spec §11.3 priority 2)", () => {
    expect(pkg.coverImagePath).toBe("OEBPS/cover.jpg");
  });

  it("locates the NCX when no EPUB3 nav item exists", () => {
    expect(locateNavigationDocument(pkg)).toEqual({ path: "OEBPS/toc.ncx", kind: "ncx" });
  });
});

describe("parsePackageDocument: title fallback chain (spec §8.4.1)", () => {
  it("falls back to the filename when there is no dc:title", () => {
    const xml = `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    const pkg = parsePackageDocument(entriesWithOpf(xml), OPF_PATH, "My Great Book.epub");
    expect(pkg.metadata.title).toBe("My Great Book");
  });

  it("falls back to 'EPUB document' when there is no title or filename", () => {
    const xml = `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    const pkg = parsePackageDocument(entriesWithOpf(xml), OPF_PATH);
    expect(pkg.metadata.title).toBe("EPUB document");
  });
});

describe("resolveEpubTitle / resolveEpubAuthor helpers", () => {
  it("resolveEpubTitle skips empty titles before falling back", () => {
    expect(resolveEpubTitle(["   ", "Real Title"], undefined)).toBe("Real Title");
  });

  it("resolveEpubAuthor caps at 3 creators and drops empties", () => {
    expect(resolveEpubAuthor(["A", "", "B", "C", "D"])).toBe("A / B / C");
  });

  it("resolveEpubAuthor returns undefined for no creators", () => {
    expect(resolveEpubAuthor([])).toBeUndefined();
  });
});

describe("parsePackageDocument: Fixed Layout detection (spec §8.4.3 / §19.1 fixed layout)", () => {
  it("detects EPUB3 rendition:layout=pre-paginated", () => {
    const xml = `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>FXL</dc:title><meta property="rendition:layout">pre-paginated</meta></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    const pkg = parsePackageDocument(entriesWithOpf(xml), OPF_PATH);
    expect(pkg.isFixedLayout).toBe(true);
    expect(pkg.metadata.renditionLayout).toBe("pre-paginated");
  });

  it("detects the EPUB2-era fixed-layout meta hint", () => {
    const xml = `<package version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>FXL2</dc:title><meta name="fixed-layout" content="true"/></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    const pkg = parsePackageDocument(entriesWithOpf(xml), OPF_PATH);
    expect(pkg.isFixedLayout).toBe(true);
  });

  it("detects the region-mag meta hint (review M3: Adobe Digital Editions / iBooks region magnification, EPUB2-only fixed layout)", () => {
    const xml = `<package version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>RegionMag</dc:title><meta name="region-mag" content="true"/></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    const pkg = parsePackageDocument(entriesWithOpf(xml), OPF_PATH);
    expect(pkg.isFixedLayout).toBe(true);
  });
});

describe("parsePackageDocument: 重複ID (spec §19.1 duplicate id)", () => {
  it("rejects a manifest with two items sharing the same id", () => {
    const xml = `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Dup</dc:title></metadata><manifest><item id="c1" href="a.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    expect(() => parsePackageDocument(entriesWithOpf(xml), OPF_PATH)).toThrow(EpubError);
    try {
      parsePackageDocument(entriesWithOpf(xml), OPF_PATH);
    } catch (error) {
      expect((error as EpubError).code).toBe("INVALID_PACKAGE");
    }
  });
});

describe("parsePackageDocument: 空spine (spec §19.1 empty spine)", () => {
  it("throws EMPTY_SPINE when <spine> has no itemref", () => {
    const xml = `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Empty</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine></spine></package>`;
    expect(() => parsePackageDocument(entriesWithOpf(xml), OPF_PATH)).toThrow(EpubError);
    try {
      parsePackageDocument(entriesWithOpf(xml), OPF_PATH);
    } catch (error) {
      expect((error as EpubError).code).toBe("EMPTY_SPINE");
    }
  });

  it("throws EMPTY_SPINE when there is no <spine> element at all", () => {
    const xml = `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>NoSpine</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest></package>`;
    expect(() => parsePackageDocument(entriesWithOpf(xml), OPF_PATH)).toThrow(EpubError);
  });
});

describe("parsePackageDocument: 不正href (spec §19.1 invalid href)", () => {
  it("rejects a manifest href that escapes the archive root", () => {
    const xml = `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Escape</dc:title></metadata><manifest><item id="c1" href="../../etc/passwd" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    expect(() => parsePackageDocument(entriesWithOpf(xml), OPF_PATH)).toThrow(EpubError);
    try {
      parsePackageDocument(entriesWithOpf(xml), OPF_PATH);
    } catch (error) {
      expect((error as EpubError).code).toBe("UNSAFE_PATH");
    }
  });

  it("rejects a spine itemref with no matching manifest item", () => {
    const xml = `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Missing</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ghost"/></spine></package>`;
    expect(() => parsePackageDocument(entriesWithOpf(xml), OPF_PATH)).toThrow(EpubError);
    try {
      parsePackageDocument(entriesWithOpf(xml), OPF_PATH);
    } catch (error) {
      expect((error as EpubError).code).toBe("MISSING_SPINE_ITEM");
    }
  });
});

describe("parsePackageDocument: missing package (spec §17.1 MISSING_PACKAGE)", () => {
  it("throws MISSING_PACKAGE when the OPF entry is absent", () => {
    expect(() => parsePackageDocument(new Map(), OPF_PATH)).toThrow(EpubError);
    try {
      parsePackageDocument(new Map(), OPF_PATH);
    } catch (error) {
      expect((error as EpubError).code).toBe("MISSING_PACKAGE");
    }
  });
});

describe("parsePackageDocument: DOCTYPE / ENTITY (design decision D3)", () => {
  it("rejects a DOCTYPE declaration in the OPF", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE package><package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>X</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    expect(() => parsePackageDocument(entriesWithOpf(xml), OPF_PATH)).toThrow(EpubError);
  });
});
