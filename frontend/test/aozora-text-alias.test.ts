// SPDX-License-Identifier: AGPL-3.0-or-later
// 共有パッケージ @html2xtc/aozora-text をフロントエンドから解決できることの
// 疎通確認（実装ブリーフ: tsconfig paths + vite/vitest resolve.alias）。
// パーサーをフロントへ複製しないための唯一の import 経路がここで機能する
// ことを固定する — 本番UIの配線自体はP4で行う。
import { describe, expect, it } from "vitest";
import {
  detectAozoraFormat,
  parseAozoraDocument,
  renderDocumentToHtml,
  type AozoraDocument,
} from "@html2xtc/aozora-text";

describe("@html2xtc/aozora-text resolves from the frontend", () => {
  it("detectAozoraFormat is callable", () => {
    expect(detectAozoraFormat("ただの文章です。").isAozora).toBe(false);
  });

  it("parseAozoraDocument + renderDocumentToHtml round-trip", () => {
    const doc: AozoraDocument = parseAozoraDocument("第一段落\n\n第二段落");
    expect(renderDocumentToHtml(doc)).toBe("<p>第一段落</p>\n<p>第二段落</p>");
  });
});
