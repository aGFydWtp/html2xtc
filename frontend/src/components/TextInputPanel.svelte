<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { submitText, type TextUploadHandle } from "../lib/convert.svelte";
  import { t } from "../lib/i18n.svelte";
  import { decodeTextBytes, TextDecodeError, type EncodingDetectionResult } from "../lib/text-decode";
  import { countCharacters, countLines, normalizeText, textToParagraphHtml } from "../lib/text-normalize";
  import {
    applyTextPreset,
    DEFAULT_TEXT_OPTIONS,
    isValidTextOptions,
    type TextConvertOptions,
    type TextPresetId,
  } from "../lib/text-options";
  import {
    buildTextXtcPreviewCacheKey,
    LimitedCache,
    requestTextXtcPreview,
    resolveTextPreviewErrorMessageKey,
    TEXT_X3_PREVIEW_CACHE_LIMIT,
    TextPreviewRequestError,
  } from "../lib/text-xtc-preview";
  import { decodeFrame, parseXtc, type ParsedXtc } from "../lib/xtc";
  import TextOptions from "./TextOptions.svelte";

  let { file, onRemove }: { file: File; onRemove: () => void } = $props();

  let status = $state<"loading" | "ready" | "error">("loading");
  let errorKind = $state<"encoding_unknown" | "utf16" | "binary" | "empty" | null>(null);
  let decodedText = $state("");
  let detectionResult = $state<EncodingDetectionResult | null>(null);
  let normalizedText = $state("");

  let options = $state<TextConvertOptions>({
    ...DEFAULT_TEXT_OPTIONS,
    margins: { ...DEFAULT_TEXT_OPTIONS.margins },
  });

  // 表題(options.title)の初期値をファイル名（拡張子除く）から自動導出する。
  // ユーザーが手入力した表題は上書きしない — 「表題が空、または直前ファイルから
  // 自動導出した値のまま」の場合のみ、新しいファイル名から再導出する。
  let autoTitle = $state("");

  function deriveTitleFromFileName(name: string): string {
    return name.replace(/\.txt$/i, "").slice(0, 100);
  }

  $effect(() => {
    const derived = deriveTitleFromFileName(file.name);
    untrack(() => {
      if (options.title.trim() === "" || options.title === autoTitle) {
        options.title = derived;
      }
      autoTitle = derived;
    });
  });

  // プレビューのモード切替（PdfPreview.svelte 風の .seg セグメント）。"source" は
  // デコード・正規化済みの全文をスクロール表示、"x3" は実機XTCのインライン表示。
  // PDF側にある compare 相当のモードはTXTには存在しない。
  let previewMode = $state<"source" | "x3">("source");

  // 本文全文プレビュー（段落分割・エスケープ済みHTML）。組版精度は求めない
  // プレーンな段落表示。
  const bodyPreviewHtml = $derived(textToParagraphHtml(normalizedText));

  let uploading = $state(false);
  let uploadPercent = $state<number | null>(null);
  let uploadFailedText = $state<string | null>(null);
  let uploadHandleRef: TextUploadHandle | null = null;

  // X3実機プレビュー（POST /preview/text、実装仕様書 §18）。世代カウンタ +
  // AbortController で、設定変更後の再生成が古い結果で新しい結果を上書きしない
  // ようにする。古い結果は届いても破棄するだけで、UI上の表示は常に最新世代のみ。
  let x3PreviewGeneration = 0;
  let x3PreviewController: AbortController | null = null;
  let x3PreviewGenerating = $state(false);
  let x3PreviewErrorText = $state<string | null>(null);
  let x3Parsed = $state<ParsedXtc | null>(null);
  let x3CurrentPage = $state(0);
  let x3CanvasEl = $state<HTMLCanvasElement | null>(null);

  // 同一入力（送信本文+options）でのX3プレビュー再生成をAPI再取得なしで即座に
  // 表示するためのメモリキャッシュ。素の Map（$state不要）— UI描画には関与せず、
  // generateX3Preview() 内でのみ読み書きする内部最適化。1ファイル=1インスタンス
  // のコンポーネントなのでファイル識別子は不要。
  const x3PreviewCache = new LimitedCache<string, ParsedXtc>(TEXT_X3_PREVIEW_CACHE_LIMIT);

  // XTCの現在ページを canvas へデコード描画する（PreviewDialog.svelte の
  // decodeFrame → putImageData パターンを流用）。.pv-page の CSS が
  // width:100%/height:100% で528:792枠に収めるため、canvas自体の実寸は
  // デコードした画像の実寸のままでよい。
  $effect(() => {
    if (previewMode !== "x3" || !x3Parsed || !x3CanvasEl) return;
    const parsed = x3Parsed;
    const page = x3CurrentPage;
    const canvas = x3CanvasEl;
    try {
      const image = decodeFrame(parsed.dv, parsed.pages[page]);
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d")?.putImageData(image, 0, 0);
    } catch {
      x3Parsed = null;
      x3PreviewErrorText = t("text_x3_preview_failed");
    }
  });

  function prevX3Page(): void {
    if (x3CurrentPage > 0) x3CurrentPage -= 1;
  }
  function nextX3Page(): void {
    if (x3Parsed && x3CurrentPage < x3Parsed.pages.length - 1) x3CurrentPage += 1;
  }

  // 文字コード選択(TextOptions内)の復旧導線: デコード失敗時は詳細設定アコーディオンを
  // 自動展開させる必要があるため、error状態かどうかをそのまま渡す。
  const hasEncodingError = $derived(status === "error");

  const charCount = $derived(countCharacters(normalizedText));
  const lineCount = $derived(countLines(normalizedText));
  const optionsValid = $derived(isValidTextOptions(options));
  const canSubmit = $derived(status === "ready" && optionsValid && !uploading);

  // options はプリセットや setTextLayout でオブジェクトごと差し替わる。$effect 内で
  // options.* を直接読むと参照の変更だけで再実行され、レイアウト切替のたびに再デコード
  // →status が一瞬 loading になり配下のコンポーネント（組版設定アコーディオン等）が
  // 再マウントされてしまう。$derived は値が変わらない限り通知しないため、依存を
  // プリミティブ値に絞れる。
  const requestedEncoding = $derived(options.encoding);
  const normMaxBlankLines = $derived(options.maxConsecutiveBlankLines);
  const normPreserveSpaces = $derived(options.preserveSpaces);
  const normJoinLines = $derived(options.joinHardWrappedLines);

  // 文字コード判定・デコード（仕様書 §5）。ファイルまたは文字コード指定が変わる
  // たびに再デコードする。
  $effect(() => {
    let cancelled = false;
    status = "loading";
    errorKind = null;
    const current = file;
    const encoding = requestedEncoding;
    void (async () => {
      try {
        const bytes = new Uint8Array(await current.arrayBuffer());
        if (cancelled) return;
        const { text, result } = decodeTextBytes(bytes, encoding);
        if (cancelled) return;
        decodedText = text;
        detectionResult = result;
        status = "ready";
      } catch (e) {
        if (cancelled) return;
        status = "error";
        errorKind = e instanceof TextDecodeError ? e.kind : "encoding_unknown";
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // 正規化（仕様書 §8, §10.8: 空行上限・空白保持・行の自動連結の変更は150msデバウンスで再処理）。
  let normalizeTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const text = decodedText;
    const maxConsecutiveBlankLines = normMaxBlankLines;
    const preserveSpaces = normPreserveSpaces;
    const joinHardWrappedLines = normJoinLines;
    const ready = status === "ready";
    if (normalizeTimer) clearTimeout(normalizeTimer);
    if (!ready) {
      normalizedText = "";
      return;
    }
    normalizeTimer = setTimeout(() => {
      normalizedText = normalizeText(text, {
        maxConsecutiveBlankLines,
        preserveSpaces,
        joinHardWrappedLines,
      }).text;
    }, 150);
    return () => {
      if (normalizeTimer) clearTimeout(normalizeTimer);
    };
  });

  function formatSize(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function loadErrorText(kind: "encoding_unknown" | "utf16" | "binary" | "empty"): string {
    if (kind === "utf16") return t("text_err_utf16");
    if (kind === "binary") return t("text_err_binary");
    if (kind === "empty") return t("text_err_empty");
    return t("text_err_encoding_unknown");
  }

  function applyPreset(preset: TextPresetId): void {
    options = applyTextPreset(options, preset);
  }

  async function onConvert(): Promise<void> {
    if (!canSubmit) return;
    uploading = true;
    uploadPercent = null;
    uploadFailedText = null;
    const session = submitText(file, options, (percent) => { uploadPercent = percent; });
    uploadHandleRef = session.handle;
    const result = await session.done;
    uploadHandleRef = null;
    uploading = false;
    if (result.aborted) {
      uploadPercent = null;
      return;
    }
    if (!result.ok) {
      uploadFailedText = t("text_err_upload_failed");
      uploadPercent = null;
      return;
    }
    onRemove();
  }

  function cancelUpload(): void {
    uploadHandleRef?.abort();
  }

  // X3実機プレビュー生成（実装仕様書 §14/§18）。クリックのたびに前回の
  // リクエストを中止して新しい世代を開始する — 設定変更後の再クリックがそのまま
  // 「中止して再生成」になる（専用の中止ボタンは設けない、仕様書のUIモック通り）。
  async function generateX3Preview(): Promise<void> {
    x3PreviewController?.abort();
    // キャッシュヒット時はfetchを発行せず即座に表示する。既存の in-flight
    // リクエストは上のabort()で中断済みなので、世代カウンタだけ進めて
    // （古い世代のfinally/catchが後から状態を書き換えないようにして）終える。
    const cacheKey = buildTextXtcPreviewCacheKey(normalizedText, options);
    const cached = x3PreviewCache.get(cacheKey);
    if (cached) {
      x3PreviewGeneration++;
      x3PreviewController = null;
      x3PreviewGenerating = false;
      x3PreviewErrorText = null;
      x3Parsed = cached;
      x3CurrentPage = 0;
      return;
    }
    const generation = ++x3PreviewGeneration;
    const controller = new AbortController();
    x3PreviewController = controller;
    x3PreviewGenerating = true;
    x3PreviewErrorText = null;
    try {
      const bytes = await requestTextXtcPreview(normalizedText, options, controller.signal);
      if (generation !== x3PreviewGeneration) return; // 古い世代の結果は破棄
      const parsed = parseXtc(bytes);
      x3PreviewCache.set(cacheKey, parsed);
      x3Parsed = parsed;
      x3CurrentPage = 0;
    } catch (e) {
      if (generation !== x3PreviewGeneration) return;
      if (e instanceof DOMException && e.name === "AbortError") return; // 中断は無視
      const code = e instanceof TextPreviewRequestError ? e.code : "UNKNOWN";
      x3PreviewErrorText = t(resolveTextPreviewErrorMessageKey(code));
    } finally {
      if (generation === x3PreviewGeneration) {
        x3PreviewGenerating = false;
        x3PreviewController = null;
      }
    }
  }

  // コンポーネント破棄時（TXTファイル削除等でこのパネルが消える場合）、in-flight の
  // プレビューリクエストを中止する。中止し忘れると、最大 TEXT_PREVIEW_TIMEOUT_MS
  // (120秒) 後にレスポンスが届いた時点で、既にこのパネルとは無関係になった画面へ
  // 勝手に x3Parsed がセットされてしまう。世代カウンタも同時に進めておくことで、
  // 万一 abort() が AbortError 以外の形で解決した場合でも既存の世代ガード
  // （generation !== x3PreviewGeneration）が二重に守る。
  onDestroy(() => {
    x3PreviewController?.abort();
    x3PreviewGeneration++;
  });
</script>

<div class="text-panel">
  <div class="att-row">
    <span class="att-badge">TXT</span>
    <div class="att-info">
      <div class="att-name">{file.name}</div>
      <div class="att-meta">{t("text_meta_line")(formatSize(file.size), charCount, lineCount)}</div>
    </div>
    <button type="button" class="att-x" onclick={onRemove} aria-label={t("text_remove_file")}>×</button>
  </div>

  {#if status === "ready"}
    <div class="pv-wrap">
      <div class="pv-frame">
        {#if previewMode === "source"}
          <div class="pv-page pv-page-scroll">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- bodyPreviewHtml は textToParagraphHtml が escapeHtml 済みの本文から生成する固定タグ(<p>/<br>)のみを含む -->
            <div class="body-text">{@html bodyPreviewHtml}</div>
          </div>
        {:else}
          <div class="pv-page">
            {#if x3PreviewGenerating}
              <span class="spinner"></span>
            {:else if x3Parsed}
              <canvas bind:this={x3CanvasEl}></canvas>
            {/if}
          </div>
        {/if}
      </div>
      {#if previewMode === "x3" && x3Parsed}
        <div class="pv-pager">
          <button type="button" onclick={prevX3Page} disabled={x3CurrentPage <= 0} aria-label={t("preview_prev")}>‹</button>
          <span class="pv-count">{t("text_x3_page_indicator")(x3CurrentPage + 1, x3Parsed.pages.length)}</span>
          <button type="button" onclick={nextX3Page} disabled={x3CurrentPage >= x3Parsed.pages.length - 1} aria-label={t("preview_next")}>›</button>
        </div>
      {/if}
      <div class="seg">
        <button type="button" aria-pressed={previewMode === "source"} onclick={() => (previewMode = "source")}>{t("text_tab_body")}</button>
        <button type="button" aria-pressed={previewMode === "x3"} onclick={() => (previewMode = "x3")}>{t("text_tab_x3")}</button>
      </div>
      {#if previewMode === "x3"}
        <div class="x3-preview-actions">
          <button
            type="button"
            class="secondary"
            disabled={!optionsValid}
            onclick={() => void generateX3Preview()}
          >
            {x3PreviewGenerating ? t("text_x3_preview_generating") : t("text_x3_preview_button")}
          </button>
          {#if x3PreviewErrorText}<div class="error-text">{x3PreviewErrorText}</div>{/if}
          <p class="preview-note">{t("text_x3_preview_note")}</p>
        </div>
      {/if}
    </div>
  {:else if status === "loading"}
    <div class="preview-placeholder"><span class="spinner"></span></div>
  {:else if status === "error" && errorKind}
    <div class="preview-placeholder error-text">{loadErrorText(errorKind)}</div>
  {/if}

  {#if status === "ready"}
    <div class="field">
      <div class="opt-label">{t("text_presets_label")}</div>
      <div class="seg">
        <button type="button" onclick={() => applyPreset("standard")}>{t("text_preset_standard")}</button>
        <button type="button" onclick={() => applyPreset("vertical_novel")}>{t("text_preset_vertical_novel")}</button>
        <button type="button" onclick={() => applyPreset("large_font")}>{t("text_preset_large_font")}</button>
      </div>
    </div>
  {/if}

  {#if status !== "loading"}
    <TextOptions bind:options {detectionResult} {hasEncodingError} />
  {/if}

  {#if uploading}
    <div class="upload-row">
      <div class="upload-bar"><div class="upload-fill" style="width:{uploadPercent ?? 0}%"></div></div>
      <span class="upload-label">{uploadPercent === null ? t("text_uploading_indeterminate") : t("text_uploading")(uploadPercent)}</span>
      <button type="button" class="secondary" onclick={cancelUpload}>{t("cancel")}</button>
    </div>
  {:else}
    {#if uploadFailedText}<div class="error-text">{uploadFailedText}</div>{/if}
    {#if status === "ready" && !optionsValid}<div class="error-text">{t("text_options_invalid")}</div>{/if}
    <button type="button" class="primary convert-btn" disabled={!canSubmit} onclick={() => void onConvert()}>{t("convert")}</button>
  {/if}
</div>

<style>
  .text-panel { padding: 20px 0; display: flex; flex-direction: column; gap: 16px; }
  .preview-placeholder {
    width: 100%; max-width: 220px; aspect-ratio: 528 / 792; display: flex; align-items: center;
    justify-content: center; background: #fff; border: 1.5px solid var(--ink); border-radius: 4px;
    box-shadow: 3px 3px 0 var(--line); margin: 0 auto; padding: 16px; text-align: center; font-size: 13px;
  }
  .att-row {
    display: flex; align-items: center; gap: 12px; border: 1px solid var(--line); border-radius: 4px;
    background: var(--card); padding: 12px 16px; text-align: left;
  }
  .att-badge {
    flex: none; font-family: var(--mono); font-size: 12px; font-weight: 600; padding: 3px 8px;
    background: var(--panel); color: #4d4a42; border-radius: 4px;
  }
  .att-info { flex: 1; min-width: 0; }
  .att-name { font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .att-meta { font-family: var(--mono); font-size: 12px; color: var(--faint); margin-top: 2px; }
  .att-x {
    flex: none; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--line); border-radius: 4px; background: none; color: var(--muted);
    font-size: 13px; line-height: 1; cursor: pointer; padding: 0; font-family: inherit;
  }
  .att-x:hover { background: var(--panel); }

  .field { display: flex; flex-direction: column; gap: 6px; }
  .opt-label { font-size: 13px; font-weight: 600; color: var(--muted2); letter-spacing: .02em; }

  .pv-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .pv-frame { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; width: 100%; }
  .pv-page {
    position: relative; width: 100%; max-width: 220px; aspect-ratio: 528 / 792; background: #fff;
    border: 1.5px solid var(--ink); border-radius: 4px; box-shadow: 3px 3px 0 var(--line);
    overflow: hidden; margin: 0 auto; display: flex; align-items: center; justify-content: center;
  }
  .pv-page canvas { display: block; width: 100%; height: 100%; }
  .pv-page.pv-page-scroll {
    display: block; overflow-y: auto; overflow-x: hidden; align-items: unset; justify-content: unset;
    padding: 14px; box-sizing: border-box; text-align: left;
  }
  .body-text { font-size: 12px; line-height: 1.8; color: #1c1a17; overflow-wrap: anywhere; }
  .body-text :global(p) { margin: 0 0 1em; }
  .body-text :global(p:last-child) { margin-bottom: 0; }
  .pv-pager { display: flex; align-items: center; gap: 14px; }
  .pv-pager button {
    width: 30px; height: 30px; border-radius: 4px; border: 1px solid var(--line);
    background: var(--card); color: var(--text); cursor: pointer; font-size: 16px; line-height: 1;
  }
  .pv-pager button:disabled { color: var(--disabled); cursor: default; }
  .pv-count { font-family: var(--mono); font-size: 13px; color: var(--muted2); }
  .pv-wrap .seg { align-self: center; }

  .preview-note { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.7; }
  .x3-preview-actions { display: flex; flex-direction: column; gap: 8px; align-items: center; margin-top: 4px; }
  .x3-preview-actions button.secondary { align-self: center; }

  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; align-self: flex-start; }
  .seg button {
    padding: 7px 14px; font: inherit; font-size: 13px; border: 0; background: var(--card);
    color: var(--muted2); cursor: pointer; border-right: 1px solid var(--line);
  }
  .seg button:last-child { border-right: 0; }
  .seg button:hover { background: var(--panel); }
  .seg button[aria-pressed="true"] { background: var(--ink); color: var(--ink-text); font-weight: 700; }

  button.primary {
    padding: 12px 26px; font: inherit; font-size: 15px; font-weight: 700; letter-spacing: .08em;
    border: 0; border-radius: 4px; background: var(--ink); color: var(--ink-text); cursor: pointer;
  }
  button.primary:disabled { opacity: .55; cursor: default; }
  button.primary.convert-btn { display: block; width: 100%; padding: 14px 0; }
  button.secondary {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  button.secondary:hover { background: var(--panel); }
  .upload-row { display: flex; align-items: center; gap: 12px; }
  .upload-bar { flex: 1; height: 8px; border-radius: 4px; background: var(--panel); overflow: hidden; }
  .upload-fill { height: 100%; background: var(--ink); transition: width .15s; }
  .upload-label { font-family: var(--mono); font-size: 13px; color: var(--muted2); white-space: nowrap; }
</style>
