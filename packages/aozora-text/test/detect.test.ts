// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { detectAozoraFormat } from "../src/detect";

describe("detectAozoraFormat", () => {
  it("scores plain text with none of the signals as 0 / not aozora", () => {
    const result = detectAozoraFormat("これはただの文章です。特に何もありません。");
    expect(result.score).toBe(0);
    expect(result.isAozora).toBe(false);
  });

  it("does not flag a single ruby marker alone", () => {
    const result = detectAozoraFormat("彼は倫敦《ロンドン》に住んでいた。");
    expect(result.score).toBe(2);
    expect(result.isAozora).toBe(false);
  });

  it("flags 2+ ［＃ annotations plus ruby as aozora (>=5)", () => {
    const text = "第一章［＃「第一章」は大見出し］\n彼は倫敦《ロンドン》に住んでいた。［＃改ページ］";
    const result = detectAozoraFormat(text);
    expect(result.score).toBeGreaterThanOrEqual(5);
    expect(result.isAozora).toBe(true);
  });

  it("flags the 青空文庫作成ファイル footer alone as aozora", () => {
    const result = detectAozoraFormat("この作品は青空文庫作成ファイルです。");
    expect(result.score).toBe(4);
    expect(result.isAozora).toBe(false);
  });

  it("flags 底本： and 入力： together", () => {
    const result = detectAozoraFormat("底本：「草枕」\n入力：山田太郎");
    expect(result.score).toBe(3);
    expect(result.isAozora).toBe(false);
  });

  it("combines signals to cross the threshold", () => {
    const result = detectAozoraFormat(
      "底本：「草枕」\n入力：山田太郎\nこの作品は青空文庫作成ファイルです。",
    );
    expect(result.score).toBe(7);
    expect(result.isAozora).toBe(true);
  });
});
