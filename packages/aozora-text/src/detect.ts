// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Auto-detection heuristic (spec §15.2) for the WebUI's inputFormat
 * auto-selection (PR4's scope — this function is implemented in PR1
 * because it is pure and self-contained, but is not wired into the WebUI
 * until PR4). Only triggers "aozora" at high confidence: a single
 * `《...》` never scores high enough alone (spec §15.2's explicit
 * "単一の《...》だけでは自動判定しない").
 */
export interface AozoraDetectionResult {
  score: number;
  isAozora: boolean;
}

/** 5+ points selects `aozora` (spec §15.2's scoring table). */
const AOZORA_DETECTION_THRESHOLD = 5;

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count++;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

export function detectAozoraFormat(text: string): AozoraDetectionResult {
  let score = 0;

  if (countOccurrences(text, "［＃") >= 2) {
    score += 3;
  }
  if (/《[^》]*》/.test(text)) {
    score += 2;
  }
  if (text.includes("青空文庫作成ファイル")) {
    score += 4;
  }
  if (text.includes("テキスト中に現れる記号について")) {
    score += 4;
  }
  if (text.includes("底本：") && text.includes("入力：")) {
    score += 3;
  }

  return { score, isAozora: score >= AOZORA_DETECTION_THRESHOLD };
}
