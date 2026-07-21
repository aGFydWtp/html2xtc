<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { PDFDocumentProxy } from "pdfjs-dist";
  import { onDestroy } from "svelte";
  import type { PdfConvertOptions } from "../lib/pdf-options";
  import {
    bitsToCanvas,
    buildGrayscaleFrame,
    DitherWorkerClient,
    LimitedPageCache,
    OUTPUT_HEIGHT,
    OUTPUT_WIDTH,
    PDF_PREVIEW_DPI,
    REDRAW_DEBOUNCE_MS,
    renderPdfPageToCanvas,
  } from "../lib/pdf-preview";
  import { t } from "../lib/i18n.svelte";

  let {
    pdfDocument,
    options,
    currentPage = $bindable(1),
    pageCount,
  }: {
    pdfDocument: PDFDocumentProxy;
    options: PdfConvertOptions;
    currentPage: number;
    pageCount: number;
  } = $props();

  let mode = $state<"source" | "x3" | "compare">("x3");
  let sourceCanvasEl = $state<HTMLCanvasElement | null>(null);
  let x3CanvasEl = $state<HTMLCanvasElement | null>(null);
  let rawPageCanvas = $state<HTMLCanvasElement | null>(null);
  let renderFailed = $state(false);
  let renderToken = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // 元ページ（PDF.js 描画結果）のキャッシュ。ページ変更時だけ再描画し、
  // 回転・クロップ・しきい値等の変更ではここへは触れない（§7.8）。
  const pageCache = new LimitedPageCache<HTMLCanvasElement>();
  const ditherClient = new DitherWorkerClient();

  onDestroy(() => ditherClient.terminate());

  // ページ変更時のみ PDF.js で再描画する（デバウンスなし）。
  $effect(() => {
    const page = currentPage;
    const token = ++renderToken;
    renderFailed = false;
    void loadRawPage(page, token);
  });

  async function loadRawPage(page: number, token: number): Promise<void> {
    const cached = pageCache.get(page);
    if (cached) {
      if (token === renderToken) rawPageCanvas = cached;
      return;
    }
    try {
      const pdfPage = await pdfDocument.getPage(page);
      if (token !== renderToken) return;
      const canvas = await renderPdfPageToCanvas(pdfPage, PDF_PREVIEW_DPI);
      if (token !== renderToken) return;
      pageCache.set(page, canvas);
      rawPageCanvas = canvas;
    } catch {
      if (token === renderToken) { rawPageCanvas = null; renderFailed = true; }
    }
  }

  // 設定変更（回転・クロップ・収め方・余白・しきい値・反転・ディザリング・表示モード）
  // は 150ms デバウンスして再描画する（§7.8）。
  $effect(() => {
    // 依存として読む（Svelte のリアクティビティ追跡のため）
    void [
      rawPageCanvas, mode,
      options.rotation, options.crop.top, options.crop.right, options.crop.bottom, options.crop.left,
      options.fit, options.marginPx, options.threshold, options.dither, options.ditherStrength, options.invert,
    ];
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void redraw(), REDRAW_DEBOUNCE_MS);
    return () => { if (debounceTimer) clearTimeout(debounceTimer); };
  });

  async function redraw(): Promise<void> {
    if (!rawPageCanvas) return;
    const token = renderToken;
    const needSource = mode === "source" || mode === "compare";
    const needX3 = mode === "x3" || mode === "compare";
    if (needSource && sourceCanvasEl) paintSource(sourceCanvasEl, rawPageCanvas);
    if (needX3) {
      const frame = buildGrayscaleFrame(rawPageCanvas, options);
      const bits = await ditherClient.run(frame, options);
      if (token !== renderToken || !bits) return;
      const bitCanvas = bitsToCanvas(bits, frame.width, frame.height);
      if (x3CanvasEl) paintFinal(x3CanvasEl, bitCanvas);
    }
  }

  // 元PDFモード: PDF.js が描画したページをそのまま、528:792 の枠に収まるよう
  // 縮小表示するだけ（回転・クロップ・二値化などは適用しない。§7.7）。
  function paintSource(target: HTMLCanvasElement, source: HTMLCanvasElement): void {
    target.width = OUTPUT_WIDTH;
    target.height = OUTPUT_HEIGHT;
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    const scale = Math.min(OUTPUT_WIDTH / source.width, OUTPUT_HEIGHT / source.height);
    const w = source.width * scale;
    const h = source.height * scale;
    ctx.drawImage(source, (OUTPUT_WIDTH - w) / 2, (OUTPUT_HEIGHT - h) / 2, w, h);
  }

  function paintFinal(target: HTMLCanvasElement, source: HTMLCanvasElement): void {
    target.width = source.width;
    target.height = source.height;
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(source, 0, 0);
  }

  function prevPage(): void { if (currentPage > 1) currentPage -= 1; }
  function nextPage(): void { if (currentPage < pageCount) currentPage += 1; }
</script>

<div class="pv-wrap">
  <div class="pv-label">{t("pdf_preview_label")}</div>
  <div class="pv-frame" class:compare={mode === "compare"}>
    <div class="pv-page" class:pv-hidden={mode === "x3"}>
      <canvas bind:this={sourceCanvasEl} width={OUTPUT_WIDTH} height={OUTPUT_HEIGHT}></canvas>
      {#if mode === "compare"}<div class="pv-page-tag">{t("pdf_mode_source")}</div>{/if}
    </div>
    <div class="pv-page" class:pv-hidden={mode === "source"}>
      <canvas bind:this={x3CanvasEl} width={OUTPUT_WIDTH} height={OUTPUT_HEIGHT}></canvas>
      {#if mode === "compare"}<div class="pv-page-tag">{t("pdf_mode_x3")}</div>{/if}
    </div>
  </div>
  <div class="pv-pager">
    <button type="button" onclick={prevPage} disabled={currentPage <= 1} aria-label={t("preview_prev")}>‹</button>
    <span class="pv-count">{t("pdf_page_indicator")(currentPage, pageCount)}</span>
    <button type="button" onclick={nextPage} disabled={currentPage >= pageCount} aria-label={t("preview_next")}>›</button>
  </div>
  <div class="pv-modes">
    <div class="seg">
      <button type="button" aria-pressed={mode === "source"} onclick={() => (mode = "source")}>{t("pdf_mode_source")}</button>
      <button type="button" aria-pressed={mode === "x3"} onclick={() => (mode = "x3")}>{t("pdf_mode_x3")}</button>
      <button type="button" aria-pressed={mode === "compare"} onclick={() => (mode = "compare")}>{t("pdf_mode_compare")}</button>
    </div>
  </div>
  <p class="pv-note">{t("pdf_preview_note")}</p>
</div>

<style>
  .pv-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .pv-label {
    align-self: flex-start; font-family: var(--mono); font-size: 12px; color: var(--muted);
    letter-spacing: .08em;
  }
  .pv-frame { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
  .pv-page {
    position: relative; width: 100%; max-width: 220px; aspect-ratio: 528 / 792; background: #fff;
    border: 1.5px solid var(--ink); border-radius: 4px; box-shadow: 3px 3px 0 var(--line);
    overflow: hidden;
  }
  .pv-frame.compare .pv-page { max-width: 46%; min-width: 110px; }
  .pv-page.pv-hidden { display: none; }
  .pv-page canvas { display: block; width: 100%; height: 100%; }
  .pv-page-tag {
    position: absolute; left: 0; right: 0; bottom: 0; padding: 2px 6px; text-align: center;
    font-family: var(--mono); font-size: 10px; color: var(--ink-text); background: rgba(28, 26, 23, .72);
  }
  .pv-pager { display: flex; align-items: center; gap: 14px; }
  .pv-pager button {
    width: 30px; height: 30px; border-radius: 4px; border: 1px solid var(--line);
    background: var(--card); color: var(--text); cursor: pointer; font-size: 16px; line-height: 1;
  }
  .pv-pager button:disabled { color: var(--disabled); cursor: default; }
  .pv-count { font-family: var(--mono); font-size: 13px; color: var(--muted2); }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
  .seg button {
    padding: 7px 14px; font: inherit; font-size: 13px; border: 0; background: var(--card);
    color: var(--muted2); cursor: pointer; border-right: 1px solid var(--line);
  }
  .seg button:last-child { border-right: 0; }
  .seg button[aria-pressed="true"] { background: var(--ink); color: var(--ink-text); font-weight: 700; }
  .pv-note { max-width: 320px; margin: 0; font-size: 12px; color: var(--faint); text-align: center; line-height: 1.7; }
</style>
