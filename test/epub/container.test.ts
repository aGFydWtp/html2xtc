// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { locatePackageDocument } from "../../src/epub/container";
import { EpubError } from "../../src/epub/errors";

function entriesOf(xml: string | undefined): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  if (xml !== undefined) {
    entries.set("META-INF/container.xml", new TextEncoder().encode(xml));
  }
  return entries;
}

const VALID_CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

describe("locatePackageDocument: happy path (spec §19.1 正常rootfile)", () => {
  it("resolves the OPF path relative to the archive root", () => {
    expect(locatePackageDocument(entriesOf(VALID_CONTAINER))).toBe("OEBPS/content.opf");
  });
});

describe("locatePackageDocument: container.xml なし", () => {
  it("throws MISSING_CONTAINER when the file is absent", () => {
    expect(() => locatePackageDocument(entriesOf(undefined))).toThrow(EpubError);
    try {
      locatePackageDocument(entriesOf(undefined));
    } catch (error) {
      expect((error as EpubError).code).toBe("MISSING_CONTAINER");
    }
  });
});

describe("locatePackageDocument: XML 不正", () => {
  it("throws INVALID_CONTAINER for unparseable XML", () => {
    expect(() => locatePackageDocument(entriesOf("not xml at all <<<"))).toThrow(EpubError);
  });

  it("throws INVALID_CONTAINER when there is no rootfile element", () => {
    const xml = `<container version="1.0"><rootfiles/></container>`;
    expect(() => locatePackageDocument(entriesOf(xml))).toThrow(EpubError);
    try {
      locatePackageDocument(entriesOf(xml));
    } catch (error) {
      expect((error as EpubError).code).toBe("INVALID_CONTAINER");
    }
  });
});

describe("locatePackageDocument: 複数 rootfile", () => {
  it("prefers the rootfile with the OEBPS package media-type", () => {
    const xml = `<container version="1.0">
      <rootfiles>
        <rootfile full-path="other.xml" media-type="application/x-other+xml"/>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`;
    expect(locatePackageDocument(entriesOf(xml))).toBe("OEBPS/content.opf");
  });

  it("falls back to the first rootfile when none carries the preferred media-type", () => {
    const xml = `<container version="1.0">
      <rootfiles>
        <rootfile full-path="OEBPS/first.opf" media-type="application/x-other+xml"/>
        <rootfile full-path="OEBPS/second.opf" media-type="application/x-other+xml"/>
      </rootfiles>
    </container>`;
    expect(locatePackageDocument(entriesOf(xml))).toBe("OEBPS/first.opf");
  });
});

describe("locatePackageDocument: OPF path traversal", () => {
  it("skips a rootfile whose full-path escapes the archive root and 422s if none remain valid", () => {
    const xml = `<container version="1.0">
      <rootfiles>
        <rootfile full-path="../../etc/passwd" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`;
    expect(() => locatePackageDocument(entriesOf(xml))).toThrow(EpubError);
    try {
      locatePackageDocument(entriesOf(xml));
    } catch (error) {
      expect((error as EpubError).code).toBe("INVALID_CONTAINER");
    }
  });

  it("falls through to the next candidate when the first has an unsafe full-path", () => {
    const xml = `<container version="1.0">
      <rootfiles>
        <rootfile full-path="../escape.opf" media-type="application/oebps-package+xml"/>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`;
    expect(locatePackageDocument(entriesOf(xml))).toBe("OEBPS/content.opf");
  });
});

describe("locatePackageDocument: DOCTYPE / ENTITY (design decision D3)", () => {
  it("rejects a DOCTYPE declaration", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE container><container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    expect(() => locatePackageDocument(entriesOf(xml))).toThrow(EpubError);
    try {
      locatePackageDocument(entriesOf(xml));
    } catch (error) {
      expect((error as EpubError).code).toBe("INVALID_CONTAINER");
    }
  });

  it("rejects an ENTITY declaration", () => {
    const xml = `<?xml version="1.0"?><!ENTITY xxe SYSTEM "file:///etc/passwd"><container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    expect(() => locatePackageDocument(entriesOf(xml))).toThrow(EpubError);
  });
});
