// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Document-structure separation (spec §8): recognizes the standard Aozora
 * TXT shape — 表題/著者 header, 記号説明 block, body, 底本 footer — using
 * known separators and labels rather than fixed line numbers (spec §8.1).
 * `parse-document.ts` calls `separateDocumentStructure` once over the whole
 * (already line-ending-normalized) document and only touches the returned
 * shape, so this file can be revised independently of the block/inline
 * parsers.
 */
export interface DocumentStructure {
  title?: string;
  author?: string;
  bodyLines: string[];
  bibliographyLines: string[];
}

// A line consisting solely of 4+ dash-like characters is the conventional
// Aozora header/footer separator (e.g. a run of 20+ ASCII hyphens).
const SEPARATOR_LINE_RE = /^[-―─—‐]{4,}$/;

function isSeparatorLine(line: string): boolean {
  return SEPARATOR_LINE_RE.test(line.trim());
}

// spec §8.3: matched by partial, whitespace-trimmed inclusion, not exact
// equality — real files wrap these in 【…】 or other framing punctuation.
const SYMBOL_BLOCK_MARKERS = ["テキスト中に現れる記号について", "青空文庫作成ファイル"];

function containsSymbolMarker(line: string): boolean {
  const trimmed = line.trim();
  return SYMBOL_BLOCK_MARKERS.some((marker) => trimmed.includes(marker));
}

// spec §8.4.
const BIBLIOGRAPHY_LABELS = ["底本：", "底本:", "初出：", "入力：", "校正：", "青空文庫作成ファイル："];

/** How far into the header a title/author separator must appear (spec
 * §8.1/§8.2's title+author are always right at the top) — bounds the
 * search so a scene-break dash line deep in the body is never mistaken for
 * the header/body boundary. */
const HEADER_SEPARATOR_SEARCH_LIMIT = 30;

/** How far past a 記号説明 heading marker to look for its closing
 * separator before giving up and removing only the marker line itself. */
const SYMBOL_BLOCK_SEARCH_LIMIT = 60;

/**
 * Removes the 記号説明 block (spec §8.3): the marker line, one immediately
 * preceding separator line (its usual visual framing), and everything up to
 * the next separator line. If no closing separator is found nearby, only
 * the marker line (plus a preceding separator, if present) is removed —
 * fail-soft rather than guessing how far the block extends.
 */
function removeSymbolBlock(lines: string[]): string[] {
  const limit = Math.min(lines.length, SYMBOL_BLOCK_SEARCH_LIMIT);
  let markerIndex = -1;
  for (let i = 0; i < limit; i++) {
    if (containsSymbolMarker(lines[i])) {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex === -1) {
    return lines;
  }

  let start = markerIndex;
  if (start > 0 && isSeparatorLine(lines[start - 1])) {
    start--;
  }

  let end = markerIndex;
  const searchLimit = Math.min(lines.length, markerIndex + SYMBOL_BLOCK_SEARCH_LIMIT);
  for (let i = markerIndex + 1; i < searchLimit; i++) {
    if (isSeparatorLine(lines[i])) {
      end = i;
      break;
    }
  }

  return [...lines.slice(0, start), ...lines.slice(end + 1)];
}

/**
 * Extracts 表題/著者 from the header region preceding the first separator
 * line found within HEADER_SEPARATOR_SEARCH_LIMIT lines (spec §8.2). When
 * no such separator exists at all, there is no basis for treating any
 * leading line as a title (a lone body with no recognizable header
 * structure keeps every line as body — the filename/"Untitled" fallback
 * chain, spec §8.2, handles the title in that case instead).
 *
 * Per spec §8.2's "表題の直後...複数行ある場合": only the first two
 * non-blank header lines become title/author; any further non-blank header
 * lines are kept as body content (not discarded, just not classified).
 */
function extractHeader(lines: string[]): { title?: string; author?: string; bodyLines: string[] } {
  const limit = Math.min(lines.length, HEADER_SEPARATOR_SEARCH_LIMIT);
  let sepIndex = -1;
  for (let i = 0; i < limit; i++) {
    if (isSeparatorLine(lines[i])) {
      sepIndex = i;
      break;
    }
  }
  if (sepIndex === -1) {
    return { bodyLines: removeSymbolBlock(lines) };
  }

  const headerLines = lines.slice(0, sepIndex);
  const nonBlankIndices: number[] = [];
  headerLines.forEach((headerLine, idx) => {
    if (headerLine.trim().length > 0) nonBlankIndices.push(idx);
  });

  const title = nonBlankIndices.length >= 1 ? headerLines[nonBlankIndices[0]].trim() : undefined;
  const author = nonBlankIndices.length >= 2 ? headerLines[nonBlankIndices[1]].trim() : undefined;
  const consumed = new Set(nonBlankIndices.slice(0, 2));

  const remainderHeader = headerLines.filter((_, idx) => !consumed.has(idx));
  const rest = lines.slice(sepIndex + 1);
  return { title, author, bodyLines: removeSymbolBlock([...remainderHeader, ...rest]) };
}

/**
 * Locates the 底本 footer boundary (spec §8.4). All three conditions must
 * hold for the FIRST candidate line found, to avoid misfiring on an
 * in-body quotation that happens to start with one of these labels:
 * (a) the label starts at the line's own beginning (not just anywhere in
 * the line), (b) the line is within the document's last 20% or immediately
 * preceded by a 2+ blank-line run, and (c) at least 2 known labels appear
 * near each other (within a 20-line window starting at the candidate).
 */
function findBibliographyStart(lines: string[]): number | undefined {
  const total = lines.length;
  const tailThreshold = Math.floor(total * 0.8);
  const labelWindow = 20;

  for (let i = 0; i < total; i++) {
    const trimmed = lines[i].trimStart();
    const matchesLabel = BIBLIOGRAPHY_LABELS.some((label) => trimmed.startsWith(label));
    if (!matchesLabel) continue;

    const inTail = i >= tailThreshold;
    const precededByBlankRun = i >= 2 && lines[i - 1].trim() === "" && lines[i - 2].trim() === "";
    if (!inTail && !precededByBlankRun) continue;

    const windowEnd = Math.min(total, i + labelWindow);
    let labelCount = 0;
    for (let j = i; j < windowEnd; j++) {
      const t = lines[j].trimStart();
      if (BIBLIOGRAPHY_LABELS.some((label) => t.startsWith(label))) labelCount++;
    }
    if (labelCount < 2) continue;

    return i;
  }
  return undefined;
}

/** Strips wholly-blank lines from just the start/end of a region — safe
 * because it only discards blank lines at the very edges (introduced as a
 * side effect of removing the header/symbol-block/footer regions around
 * them), never a blank-line run in the middle of real body content that
 * still marks a paragraph boundary (spec §10.2's "解析前の生文字列へ...
 * 連続空行の削減...を適用してはならない" is about mid-document runs, not
 * leftover edge artifacts from structure separation). */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim().length === 0) start++;
  while (end > start && lines[end - 1].trim().length === 0) end--;
  return lines.slice(start, end);
}

export function separateDocumentStructure(lines: string[]): DocumentStructure {
  const bibStart = findBibliographyStart(lines);
  const bodyAll = bibStart !== undefined ? lines.slice(0, bibStart) : lines;
  const bibliographyLines = bibStart !== undefined ? lines.slice(bibStart) : [];
  const { title, author, bodyLines } = extractHeader(bodyAll);
  return {
    title,
    author,
    bodyLines: trimBlankEdges(bodyLines),
    bibliographyLines: trimBlankEdges(bibliographyLines),
  };
}
