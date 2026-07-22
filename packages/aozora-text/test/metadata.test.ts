// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { separateDocumentStructure } from "../src/metadata";

function lines(text: string): string[] {
  return text.split("\n");
}

const STANDARD_HEADER = [
  "坊っちゃん",
  "夏目漱石",
  "",
  "-------------------------------------------------------",
  "【テキスト中に現れる記号について】",
  "",
  "《》：ルビ",
  "-------------------------------------------------------",
  "",
];

describe("separateDocumentStructure (spec §8)", () => {
  it("extracts title and author from a standard header, removing them from the body", () => {
    const structure = separateDocumentStructure(
      lines([...STANDARD_HEADER, "　親譲りの無鉄砲で小供の時から損ばかりしている。"].join("\n")),
    );
    expect(structure.title).toBe("坊っちゃん");
    expect(structure.author).toBe("夏目漱石");
    expect(structure.bodyLines.join("\n")).not.toContain("坊っちゃん");
    expect(structure.bodyLines.join("\n")).not.toContain("夏目漱石");
    expect(structure.bodyLines.join("\n")).toContain("親譲りの無鉄砲");
  });

  it("removes the 記号説明 block entirely (heading marker, framing separators, and body)", () => {
    const structure = separateDocumentStructure(
      lines([...STANDARD_HEADER, "本文だけが残る。"].join("\n")),
    );
    const body = structure.bodyLines.join("\n");
    expect(body).not.toContain("テキスト中に現れる記号について");
    expect(body).not.toContain("《》：ルビ");
    expect(body).not.toContain("-----");
    expect(body).toContain("本文だけが残る。");
  });

  it("removes a 記号説明 block introduced via the 青空文庫作成ファイル marker too", () => {
    const structure = separateDocumentStructure(
      lines(
        [
          "表題",
          "著者",
          "",
          "--------------------------",
          "青空文庫作成ファイル：このファイルは記号説明の代わりにこの行を使う場合の例です。",
          "--------------------------",
          "",
          "本文。",
        ].join("\n"),
      ),
    );
    expect(structure.bodyLines.join("\n")).not.toContain("青空文庫作成ファイル");
    expect(structure.bodyLines.join("\n")).toContain("本文。");
  });

  it("falls back to no title/author when there is no recognizable header structure", () => {
    const structure = separateDocumentStructure(lines("本文"));
    expect(structure.title).toBeUndefined();
    expect(structure.author).toBeUndefined();
    expect(structure.bodyLines.join("\n")).toBe("本文");
  });

  it("keeps a 3rd+ header line as body content instead of discarding it", () => {
    const structure = separateDocumentStructure(
      lines(["表題", "著者", "副題や訳者などの3行目", "----", "本文。"].join("\n")),
    );
    expect(structure.title).toBe("表題");
    expect(structure.author).toBe("著者");
    expect(structure.bodyLines.join("\n")).toContain("副題や訳者などの3行目");
  });

  it("separates a 底本 footer to the end, as its own bibliography region", () => {
    const structure = separateDocumentStructure(
      lines(
        [
          "本文の最後の段落。",
          "",
          "",
          "底本：「坊っちゃん」新潮文庫",
          "　　1950（昭和25）年発行",
          "入力：山田太郎",
          "校正：鈴木花子",
        ].join("\n"),
      ),
    );
    expect(structure.bibliographyLines.join("\n")).toContain("底本：「坊っちゃん」新潮文庫");
    expect(structure.bibliographyLines.join("\n")).toContain("入力：山田太郎");
    expect(structure.bodyLines.join("\n")).not.toContain("底本：");
    expect(structure.bodyLines.join("\n")).toContain("本文の最後の段落。");
  });

  it("does not misdetect a 底本： mention inside a body quotation as the bibliography footer", () => {
    const structure = separateDocumentStructure(
      lines(
        [
          "彼は言った。",
          "",
          "「底本：これは引用の中の言葉です」と彼は続けた。",
          "",
          "そしてさらに文章が続く。",
          "",
          "まだまだ本文が続いていく。",
          "",
          "最後の段落もここにある。",
        ].join("\n"),
      ),
    );
    expect(structure.bibliographyLines).toEqual([]);
    expect(structure.bodyLines.join("\n")).toContain("底本：これは引用の中の言葉です");
  });

  it("a lone 底本 label near the top with nothing else nearby is not treated as the footer", () => {
    const structure = separateDocumentStructure(
      lines(["底本：これは実は最初の行に書かれた引用のようなものです。", "", "本文。"].join("\n")),
    );
    expect(structure.bibliographyLines).toEqual([]);
  });
});
