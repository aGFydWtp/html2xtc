// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { detectInputFileKind } from "../src/lib/input-file-kind";

function makeFile(name: string, type: string): File {
  return new File(["x"], name, { type });
}

describe("detectInputFileKind", () => {
  it("detects .epub by extension regardless of MIME", () => {
    expect(detectInputFileKind(makeFile("book.epub", ""))).toBe("epub");
    expect(detectInputFileKind(makeFile("book.epub", "application/octet-stream"))).toBe("epub");
  });

  it("does not misdetect an EPUB as text (extension takes priority over MIME)", () => {
    // EPUBs are ZIP archives; some browsers/OSes may report no MIME or an
    // unrelated one. The extension check must win.
    expect(detectInputFileKind(makeFile("book.epub", "text/plain"))).toBe("epub");
  });

  it("detects .pdf by extension", () => {
    expect(detectInputFileKind(makeFile("doc.pdf", ""))).toBe("pdf");
  });

  it("detects .txt by extension", () => {
    expect(detectInputFileKind(makeFile("novel.txt", ""))).toBe("text");
  });

  it("prioritizes .epub over .pdf/.txt when somehow both match (defensive)", () => {
    expect(detectInputFileKind(makeFile("archive.epub", "application/pdf"))).toBe("epub");
  });

  it("falls back to MIME when there is no recognized extension", () => {
    expect(detectInputFileKind(makeFile("file", "application/epub+zip"))).toBe("epub");
    expect(detectInputFileKind(makeFile("file", "application/pdf"))).toBe("pdf");
    expect(detectInputFileKind(makeFile("file", "application/x-pdf"))).toBe("pdf");
    expect(detectInputFileKind(makeFile("file", "text/plain"))).toBe("text");
  });

  it("returns null for an unrecognized extension and MIME", () => {
    expect(detectInputFileKind(makeFile("image.png", "image/png"))).toBeNull();
    expect(detectInputFileKind(makeFile("file", ""))).toBeNull();
  });
});
