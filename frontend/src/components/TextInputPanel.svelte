<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { submitText, type TextUploadHandle } from "../lib/convert.svelte";
  import { t } from "../lib/i18n.svelte";
  import { decodeTextBytes, TextDecodeError, type EncodingDetectionResult } from "../lib/text-decode";
  import { countCharacters, countLines, normalizeText } from "../lib/text-normalize";
  import {
    applyTextPreset,
    DEFAULT_TEXT_OPTIONS,
    isValidTextOptions,
    type TextConvertOptions,
    type TextPresetId,
  } from "../lib/text-options";
  import TextOptions from "./TextOptions.svelte";
  import TextPagePreview from "./TextPagePreview.svelte";
  import TextPreview from "./TextPreview.svelte";

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

  let activeTab = $state<"body" | "x3">("body");

  let uploading = $state(false);
  let uploadPercent = $state<number | null>(null);
  let uploadFailedText = $state<string | null>(null);
  let uploadHandleRef: TextUploadHandle | null = null;

  const charCount = $derived(countCharacters(normalizedText));
  const lineCount = $derived(countLines(normalizedText));
  const optionsValid = $derived(isValidTextOptions(options));
  const canSubmit = $derived(status === "ready" && optionsValid && !uploading);

  // 文字コード判定・デコード（仕様書 §5）。ファイルまたは文字コード指定が変わる
  // たびに再デコードする。
  $effect(() => {
    let cancelled = false;
    status = "loading";
    errorKind = null;
    const current = file;
    const encoding = options.encoding;
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

  // 正規化（仕様書 §8, §10.8: 空行上限・空白保持の変更は150msデバウンスで再処理）。
  let normalizeTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const text = decodedText;
    const maxConsecutiveBlankLines = options.maxConsecutiveBlankLines;
    const preserveSpaces = options.preserveSpaces;
    const ready = status === "ready";
    if (normalizeTimer) clearTimeout(normalizeTimer);
    if (!ready) {
      normalizedText = "";
      return;
    }
    normalizeTimer = setTimeout(() => {
      normalizedText = normalizeText(text, { maxConsecutiveBlankLines, preserveSpaces }).text;
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

  function detectedEncodingLabel(result: EncodingDetectionResult): string {
    return result.encoding === "utf-8" ? t("text_encoding_option_utf8") : t("text_encoding_option_shift_jis");
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

  <div class="field">
    <label class="opt-label" for="text-encoding">{t("text_encoding_label")}</label>
    <select id="text-encoding" bind:value={options.encoding}>
      <option value="auto">{options.encoding === "auto" && detectionResult ? t("text_encoding_detected")(detectedEncodingLabel(detectionResult)) : t("text_encoding_option_auto")}</option>
      <option value="utf-8">{t("text_encoding_option_utf8")}</option>
      <option value="shift_jis">{t("text_encoding_option_shift_jis")}</option>
    </select>
  </div>

  {#if status === "ready"}
    <div class="tabs">
      <button type="button" class="tab" aria-pressed={activeTab === "body"} onclick={() => (activeTab = "body")}>{t("text_tab_body")}</button>
      <button type="button" class="tab" aria-pressed={activeTab === "x3"} onclick={() => (activeTab = "x3")}>{t("text_tab_x3")}</button>
    </div>
    {#if activeTab === "body"}
      <TextPreview {normalizedText} />
      <p class="preview-note">{t("text_preview_note")}</p>
    {:else}
      <TextPagePreview {normalizedText} {options} />
    {/if}
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

    <TextOptions bind:options />

    <div class="field bibliographic">
      <div class="opt-label">{t("text_bibliographic_heading")}</div>
      <label class="bib-field">
        <span>{t("text_title_label")}</span>
        <input type="text" maxlength="100" bind:value={options.title} />
      </label>
      <label class="bib-field">
        <span>{t("text_author_label")}</span>
        <input type="text" maxlength="100" bind:value={options.author} />
      </label>
    </div>
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
  select {
    padding: 8px 10px; font: inherit; font-size: 14px; border: 1px solid var(--line); border-radius: 4px;
    background: var(--card); color: var(--text); align-self: flex-start; min-width: 220px;
  }

  .tabs { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; align-self: flex-start; }
  .tab {
    padding: 8px 16px; font: inherit; font-size: 13px; border: 0; background: var(--card);
    color: var(--muted2); cursor: pointer; border-right: 1px solid var(--line);
  }
  .tab:last-child { border-right: 0; }
  .tab[aria-pressed="true"] { background: var(--ink); color: var(--ink-text); font-weight: 700; }

  .preview-note { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.7; }

  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; align-self: flex-start; }
  .seg button {
    padding: 7px 14px; font: inherit; font-size: 13px; border: 0; background: var(--card);
    color: var(--muted2); cursor: pointer; border-right: 1px solid var(--line);
  }
  .seg button:last-child { border-right: 0; }
  .seg button:hover { background: var(--panel); }

  .bibliographic { gap: 10px; }
  .bib-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .bib-field input[type="text"] {
    padding: 8px 10px; font: inherit; font-size: 14px; border: 1px solid var(--line); border-radius: 4px;
    background: var(--card); color: var(--text);
  }

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
