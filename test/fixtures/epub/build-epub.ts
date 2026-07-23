// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { deflateSync } from "node:zlib";
import { zipSync } from "fflate";
import type { Zippable } from "fflate";

/**
 * Builds EPUB (ZIP) fixtures in-memory for tests (EPUB spec §19.3: "バイナリ
 * を直接管理するより、テスト時にZIPを生成するhelperを優先する"). Uses
 * fflate's zipSync — the same library src/epub/archive.ts unzips with.
 */

export type EpubFixtureFiles = Record<string, string | Uint8Array>;

// --- minimal PNG encoder (test-only) ---------------------------------------
//
// html.ts's cover sanitization (src/epub/assets.ts's rasterImageDataUrl)
// never decodes/validates PNG structure — it base64-encodes whatever bytes
// the manifest declares image/png, so a cover fixture's actual pixel
// dimensions can't affect prepareEpubDocument's behavior either way (the
// .epub-cover fix is a fixed-size CSS box + object-fit:contain, deliberately
// aspect-ratio-agnostic — see buildFinalCss's .epub-cover doc comment). This
// encoder exists anyway so a landscape/near-square cover regression test
// fixture is an honestly-dimensioned PNG, not an arbitrary byte blob
// pretending to be one.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setUint32(0, data.length, false);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  const crcBuf = new Uint8Array(4);
  new DataView(crcBuf.buffer).setUint32(0, crc32(crcInput), false);
  const chunk = new Uint8Array(4 + typeBytes.length + data.length + 4);
  chunk.set(lenBuf, 0);
  chunk.set(typeBytes, 4);
  chunk.set(data, 4 + typeBytes.length);
  chunk.set(crcBuf, 4 + typeBytes.length + data.length);
  return chunk;
}

/** Builds a minimal, structurally-valid single-color 8-bit grayscale PNG at exactly `width`x`height` — for cover-image aspect-ratio regression fixtures (landscape/near-square/etc.) that need to be honest about their own dimensions. */
export function makeMinimalPng(width: number, height: number): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 0; // color type: grayscale
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = pngChunk("IHDR", ihdrData);

  const raw = new Uint8Array(height * (1 + width)); // filter-byte(0) + width gray bytes, per row
  const idatData = new Uint8Array(deflateSync(raw));
  const idat = pngChunk("IDAT", idatData);

  const iend = pngChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(signature.length + ihdr.length + idat.length + iend.length);
  let offset = 0;
  for (const part of [signature, ihdr, idat, iend]) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

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
