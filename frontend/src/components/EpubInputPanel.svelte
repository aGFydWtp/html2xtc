<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { submitEpub, type EpubUploadHandle } from "../lib/convert.svelte";
  import { DEFAULT_EPUB_OPTIONS, isValidEpubOptions, type EpubConvertOptions } from "../lib/epub-options";
  import { t } from "../lib/i18n.svelte";
  import EpubOptions from "./EpubOptions.svelte";

  let { file, onRemove }: { file: File; onRemove: () => void } = $props();

  // EPUBはPDF/TXTと異なりクライアント側でZIPを解凍・解析しない（仕様書 §16.4に
  // プレビュー要求がない）ため、ファイルを受け取った時点で常に変換可能な状態になる。
  let options = $state<EpubConvertOptions>({ ...DEFAULT_EPUB_OPTIONS });

  let uploading = $state(false);
  let uploadPercent = $state<number | null>(null);
  let uploadFailedText = $state<string | null>(null);
  let uploadHandleRef: EpubUploadHandle | null = null;

  const optionsValid = $derived(isValidEpubOptions(options));
  const canSubmit = $derived(optionsValid && !uploading);

  function formatSize(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  async function onConvert(): Promise<void> {
    if (!canSubmit) return;
    uploading = true;
    uploadPercent = null;
    uploadFailedText = null;
    const session = submitEpub(file, options, (percent) => { uploadPercent = percent; });
    uploadHandleRef = session.handle;
    const result = await session.done;
    uploadHandleRef = null;
    uploading = false;
    if (result.aborted) {
      uploadPercent = null;
      return; // ユーザーが中断: パネルはそのまま残す
    }
    if (!result.ok) {
      uploadFailedText = t("epub_err_upload_failed");
      uploadPercent = null;
      return;
    }
    // 成功: ジョブは CurrentJob 側のポーリング表示に移るので、パネルを閉じる。
    onRemove();
  }

  function cancelUpload(): void {
    uploadHandleRef?.abort();
  }
</script>

<div class="epub-panel">
  <div class="att-row">
    <span class="att-badge">EPUB</span>
    <div class="att-info">
      <div class="att-name">{file.name}</div>
      <div class="att-meta">{t("epub_meta_line")(formatSize(file.size))}</div>
    </div>
    <button type="button" class="att-x" onclick={onRemove} aria-label={t("epub_remove_file")}>×</button>
  </div>

  <EpubOptions bind:options />

  {#if uploading}
    <div class="upload-row">
      <div class="upload-bar"><div class="upload-fill" style="width:{uploadPercent ?? 0}%"></div></div>
      <span class="upload-label">{uploadPercent === null ? t("epub_uploading_indeterminate") : t("epub_uploading")(uploadPercent)}</span>
      <button type="button" class="secondary" onclick={cancelUpload}>{t("cancel")}</button>
    </div>
  {:else}
    {#if uploadFailedText}<div class="error-text">{uploadFailedText}</div>{/if}
    {#if !optionsValid}<div class="error-text">{t("epub_options_invalid")}</div>{/if}
    <button type="button" class="primary convert-btn" disabled={!canSubmit} onclick={() => void onConvert()}>{t("convert")}</button>
  {/if}
</div>

<style>
  .epub-panel { padding: 20px 0; display: flex; flex-direction: column; gap: 16px; }
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
