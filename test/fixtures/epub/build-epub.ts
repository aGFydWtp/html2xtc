// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { zipSync } from "fflate";
import type { Zippable } from "fflate";

/**
 * Builds EPUB (ZIP) fixtures in-memory for tests (EPUB spec §19.3: "バイナリ
 * を直接管理するより、テスト時にZIPを生成するhelperを優先する"). Uses
 * fflate's zipSync — the same library src/epub/archive.ts unzips with.
 */

export type EpubFixtureFiles = Record<string, string | Uint8Array>;

/** level 0 (store, no compression) keeps fixtures small/fast and exercises archive.ts's compression===0 path; individual tests can override per-entry via zipSync's own [data, opts] tuple form if they need compression===8. */
export function buildEpubZip(files: EpubFixtureFiles): Uint8Array {
  const zippable: Zippable = {};
  for (const [path, content] of Object.entries(files)) {
    zippable[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(zippable, { level: 0 });
}

const MINIMAL_CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const MINIMAL_NAV_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Nav</title></head>
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="chapter1.xhtml">Chapter 1</a></li>
    </ol>
  </nav>
</body>
</html>`;

function minimalChapterXhtml(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body><h1>${title}</h1><p>Hello, world.</p></body>
</html>`;
}

const MINIMAL_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:00000000-0000-0000-0000-000000000000</dc:identifier>
    <dc:title>Minimal Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`;

/**
 * A structurally valid, minimal EPUB3 (mimetype + container.xml + OPF +
 * one XHTML chapter + a nav document), suitable as a baseline for both
 * "does the happy path work" tests and for tests that mutate one file at a
 * time to exercise a specific rejection.
 */
export function minimalEpub3Files(): EpubFixtureFiles {
  return {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": MINIMAL_CONTAINER_XML,
    "OEBPS/content.opf": MINIMAL_OPF,
    "OEBPS/chapter1.xhtml": minimalChapterXhtml("Chapter 1"),
    "OEBPS/nav.xhtml": MINIMAL_NAV_XHTML,
  };
}

export function buildMinimalEpub3(overrides?: EpubFixtureFiles): Uint8Array {
  return buildEpubZip({ ...minimalEpub3Files(), ...overrides });
}

const MINIMAL_NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head></head>
  <docTitle><text>Minimal Test Book</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;

const EPUB2_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid">urn:uuid:00000000-0000-0000-0000-000000000001</dc:identifier>
    <dc:title>Minimal EPUB2 Book</dc:title>
    <dc:creator>EPUB2 Author</dc:creator>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
  </spine>
</package>`;

/** A structurally valid, minimal EPUB2 (NCX instead of a nav document, no "properties" attribute). */
export function minimalEpub2Files(): EpubFixtureFiles {
  return {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": MINIMAL_CONTAINER_XML,
    "OEBPS/content.opf": EPUB2_OPF,
    "OEBPS/chapter1.xhtml": minimalChapterXhtml("Chapter 1"),
    "OEBPS/toc.ncx": MINIMAL_NCX,
  };
}

export function buildMinimalEpub2(overrides?: EpubFixtureFiles): Uint8Array {
  return buildEpubZip({ ...minimalEpub2Files(), ...overrides });
}
