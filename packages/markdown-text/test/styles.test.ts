// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { XTC_CHAPTER_MARKER_CLASS } from "../../aozora-text/src/chapters";
import { MARKDOWN_DOCUMENT_CSS } from "../src/styles";

describe("MARKDOWN_DOCUMENT_CSS (spec §15)", () => {
  it("covers every required selector, scoped under .content", () => {
    for (const selector of [
      ".content h1",
      ".content h2",
      ".content h3",
      ".content h4",
      ".content h5",
      ".content h6",
      ".content ul",
      ".content ol",
      ".content li",
      ".content blockquote",
      ".content code",
      ".content pre",
      ".content hr",
      ".content table",
      ".content th",
      ".content td",
      ".content .md-link",
      ".content .md-image-placeholder",
    ]) {
      expect(MARKDOWN_DOCUMENT_CSS).toContain(selector);
    }
  });

  it("embeds the shared XTC chapter marker CSS", () => {
    expect(MARKDOWN_DOCUMENT_CSS).toContain(`.${XTC_CHAPTER_MARKER_CLASS}`);
  });

  it("never references an external resource", () => {
    expect(MARKDOWN_DOCUMENT_CSS).not.toMatch(/@import/i);
    expect(MARKDOWN_DOCUMENT_CSS).not.toMatch(/url\(/i);
  });

  it("never unconditionally forbids splitting a pre block across pages", () => {
    // spec §15.1: break-inside: avoid must never apply to pre/code
    // unconditionally, or a long code block could push whole pages blank.
    const preRuleMatch = MARKDOWN_DOCUMENT_CSS.match(/\.content pre\s*{[^}]*}/);
    expect(preRuleMatch).not.toBeNull();
    expect(preRuleMatch?.[0]).not.toMatch(/break-inside:\s*avoid/);
  });

  it("wraps long code/table content instead of overflowing the page", () => {
    const preRuleMatch = MARKDOWN_DOCUMENT_CSS.match(/\.content pre\s*{[^}]*}/);
    expect(preRuleMatch?.[0]).toMatch(/overflow-wrap:\s*anywhere/);
    const cellRuleMatch = MARKDOWN_DOCUMENT_CSS.match(/\.content th,\n\.content td\s*{[^}]*}/);
    expect(cellRuleMatch).not.toBeNull();
    expect(cellRuleMatch?.[0]).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
