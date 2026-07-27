// SPDX-License-Identifier: AGPL-3.0-or-later
// 共有パッケージ @html2xtc/markdown-text をフロントエンドから解決できることの
// 疎通確認（markdown-conversion 仕様書 §6.3: tsconfig paths + vite/vitest resolve.alias）。
// パーサーをフロントへ複製しないための唯一の import 経路がここで機能する
// ことを固定する。
import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import {
  createMarkdownConverter,
  MARKDOWN_IT_OPTIONS,
  MARKDOWN_DOCUMENT_CSS,
  type MarkdownConverter,
} from "@html2xtc/markdown-text";

describe("@html2xtc/markdown-text resolves from the frontend", () => {
  const converter: MarkdownConverter = createMarkdownConverter(() => new MarkdownIt(MARKDOWN_IT_OPTIONS));

  it("parses a minimal document into safe HTML", () => {
    const doc = converter.parse("# 見出し\n\n本文です。");
    expect(doc.contentHtml).toContain("<h1>");
    expect(doc.contentHtml).toContain("本文です。");
    expect(doc.firstH1).toBe("見出し");
  });

  it("exposes the shared document CSS as a non-empty string", () => {
    expect(MARKDOWN_DOCUMENT_CSS.length).toBeGreaterThan(0);
  });
});
