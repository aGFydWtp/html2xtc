// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { parsePackageDocument } from "../../src/epub/opf";
import { parseEpubNavigation } from "../../src/epub/navigation";

const OPF_PATH = "OEBPS/content.opf";

const OPF_WITH_NAV = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Nav Test</dc:title></metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;

const NAV_XHTML = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="chapter1.xhtml#s1">Chapter 1</a></li>
      <li><a href="chapter2.xhtml">Chapter 2</a></li>
    </ol>
  </nav>
</body>
</html>`;

describe("parseEpubNavigation: EPUB3 nav document", () => {
  it("extracts label/href pairs and preserves a fragment on the resolved path", () => {
    const pkg = parsePackageDocument(new Map([[OPF_PATH, new TextEncoder().encode(OPF_WITH_NAV)]]), OPF_PATH);
    const entries = new Map([
      [OPF_PATH, new TextEncoder().encode(OPF_WITH_NAV)],
      ["OEBPS/nav.xhtml", new TextEncoder().encode(NAV_XHTML)],
    ]);
    const nav = parseEpubNavigation(entries, pkg);
    expect(nav.source).toBe("nav");
    expect(nav.entries).toEqual([
      { label: "Chapter 1", href: "OEBPS/chapter1.xhtml#s1" },
      { label: "Chapter 2", href: "OEBPS/chapter2.xhtml" },
    ]);
  });
});

const OPF_WITH_NCX = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>NCX Test</dc:title></metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine>
</package>`;

const NCX_XML = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1"><navLabel><text>Chapter 1</text></navLabel><content src="chapter1.xhtml"/></navPoint>
  </navMap>
</ncx>`;

describe("parseEpubNavigation: EPUB2 NCX", () => {
  it("extracts navPoint label/src pairs", () => {
    const pkg = parsePackageDocument(new Map([[OPF_PATH, new TextEncoder().encode(OPF_WITH_NCX)]]), OPF_PATH);
    const entries = new Map([
      [OPF_PATH, new TextEncoder().encode(OPF_WITH_NCX)],
      ["OEBPS/toc.ncx", new TextEncoder().encode(NCX_XML)],
    ]);
    const nav = parseEpubNavigation(entries, pkg);
    expect(nav.source).toBe("ncx");
    expect(nav.entries).toEqual([{ label: "Chapter 1", href: "OEBPS/chapter1.xhtml" }]);
  });
});

describe("parseEpubNavigation: graceful degradation (spec §8.7 目次解析に失敗しても本文変換は継続する)", () => {
  it("returns source:none when there is no nav/NCX manifest item", () => {
    const opf = `<?xml version="1.0"?><package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>No TOC</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    const pkg = parsePackageDocument(new Map([[OPF_PATH, new TextEncoder().encode(opf)]]), OPF_PATH);
    const nav = parseEpubNavigation(new Map([[OPF_PATH, new TextEncoder().encode(opf)]]), pkg);
    expect(nav).toEqual({ source: "none", entries: [] });
  });

  it("returns source:none (never throws) when the nav document referenced by the manifest is missing from the archive", () => {
    const pkg = parsePackageDocument(new Map([[OPF_PATH, new TextEncoder().encode(OPF_WITH_NAV)]]), OPF_PATH);
    const nav = parseEpubNavigation(new Map([[OPF_PATH, new TextEncoder().encode(OPF_WITH_NAV)]]), pkg);
    expect(nav).toEqual({ source: "none", entries: [] });
  });

  it("returns source:none (never throws) when the nav document contains a DOCTYPE", () => {
    const pkg = parsePackageDocument(new Map([[OPF_PATH, new TextEncoder().encode(OPF_WITH_NAV)]]), OPF_PATH);
    const maliciousNav = `<!DOCTYPE html>${NAV_XHTML}`;
    const entries = new Map([
      [OPF_PATH, new TextEncoder().encode(OPF_WITH_NAV)],
      ["OEBPS/nav.xhtml", new TextEncoder().encode(maliciousNav)],
    ]);
    expect(parseEpubNavigation(entries, pkg)).toEqual({ source: "none", entries: [] });
  });
});
