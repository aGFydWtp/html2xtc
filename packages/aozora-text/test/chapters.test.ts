// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  XTC_CHAPTER_MARKER_CLASS,
  XTC_CHAPTER_MARKER_CSS,
  formatChapterMarker,
  normalizeChapterName,
  renderChapterMarkerHtml,
} from "../src/chapters";

describe("formatChapterMarker", () => {
  it("zero-pads to 4 digits", () => {
    expect(formatChapterMarker(1)).toBe("XTCCH0001");
    expect(formatChapterMarker(9)).toBe("XTCCH0009");
    expect(formatChapterMarker(42)).toBe("XTCCH0042");
  });

  it("does not truncate a 5+-digit index (alphanumeric contract still holds)", () => {
    expect(formatChapterMarker(12345)).toBe("XTCCH12345");
    expect(/^XTCCH[0-9]+$/.test(formatChapterMarker(12345))).toBe(true);
  });

  it("is alphanumeric only for every index in a realistic range", () => {
    for (const n of [1, 2, 10, 100, 1000]) {
      expect(/^[A-Za-z0-9]+$/.test(formatChapterMarker(n))).toBe(true);
    }
  });
});

describe("renderChapterMarkerHtml", () => {
  it("wraps the marker in a span carrying XTC_CHAPTER_MARKER_CLASS and aria-hidden (B-1: never announced by a screen reader)", () => {
    expect(renderChapterMarkerHtml("XTCCH0001")).toBe(
      `<span class="${XTC_CHAPTER_MARKER_CLASS}" aria-hidden="true">XTCCH0001</span>`,
    );
  });
});

describe("XTC_CHAPTER_MARKER_CSS", () => {
  it("uses opaque color: white (never transparent/alpha=0) + font-size: 1px — never display/visibility/opacity hiding", () => {
    // Opaque white, not `color: transparent`: measured against the
    // PRODUCTION Cloudflare Browser Rendering binding (not just a local
    // Chrome), alpha=0 text — `color: transparent` alone or combined with
    // `-webkit-text-fill-color: transparent` — is dropped from the PDF text
    // layer entirely there, unlike in local Chrome. See XTC_CHAPTER_MARKER_CSS's
    // own "WHY WHITE, NOT TRANSPARENT" doc comment (src/chapters.ts) before
    // reverting this to transparent.
    expect(XTC_CHAPTER_MARKER_CSS).toContain("color: white !important");
    expect(XTC_CHAPTER_MARKER_CSS).toContain("-webkit-text-fill-color: white !important");
    expect(XTC_CHAPTER_MARKER_CSS).not.toContain("transparent");
    expect(XTC_CHAPTER_MARKER_CSS).toContain("font-size: 1px");
    expect(XTC_CHAPTER_MARKER_CSS).not.toContain("display: none");
    expect(XTC_CHAPTER_MARKER_CSS).not.toContain("display:none");
    expect(XTC_CHAPTER_MARKER_CSS).not.toContain("visibility: hidden");
    expect(XTC_CHAPTER_MARKER_CSS).not.toContain("opacity: 0");
  });

  it("adds user-select: none (B-1: never copyable in a live DOM view, e.g. the frontend's aozora preview)", () => {
    expect(XTC_CHAPTER_MARKER_CSS).toContain("user-select: none");
    expect(XTC_CHAPTER_MARKER_CSS).toContain("-webkit-user-select: none");
  });

  it("targets exactly the .xtc-chapter-marker class", () => {
    expect(XTC_CHAPTER_MARKER_CSS).toContain(`.${XTC_CHAPTER_MARKER_CLASS} {`);
  });

  it("marks every declaration !important (must outrank src/pdf.ts's `body * { color: black !important }` on the Aozora URL-extraction path)", () => {
    // Without !important here, the class selector's higher specificity is
    // irrelevant: CSS resolves the !important tier before specificity, so a
    // normal declaration always loses to buildPrintRules()'s `body * {
    // color: black !important }` regardless of source order or selector
    // specificity — see the doc comment for the full explanation.
    for (const decl of ["color: white", "-webkit-text-fill-color: white", "font-size: 1px", "user-select: none", "-webkit-user-select: none"]) {
      expect(XTC_CHAPTER_MARKER_CSS).toContain(`${decl} !important`);
    }
  });
});

describe("normalizeChapterName", () => {
  it("collapses an embedded newline to a single half-width space", () => {
    expect(normalizeChapterName("第一\n章")).toBe("第一 章");
  });

  it("collapses a run of consecutive whitespace to one space", () => {
    expect(normalizeChapterName("第一　　　章")).toBe("第一 章");
    expect(normalizeChapterName("a    b")).toBe("a b");
  });

  it("collapses mixed newlines and spaces together", () => {
    expect(normalizeChapterName("第一\n\n  章")).toBe("第一 章");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeChapterName("  第一章  \n")).toBe("第一章");
  });

  it("leaves an already-normalized name untouched", () => {
    expect(normalizeChapterName("第一章")).toBe("第一章");
  });
});
