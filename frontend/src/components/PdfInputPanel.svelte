<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { PDFDocumentProxy } from "pdfjs-dist";
  import { onDestroy } from "svelte";
  import { submitPdf, type PdfUploadHandle } from "../lib/convert.svelte";
  import { t } from "../lib/i18n.svelte";
  import { loadPdfDocument, PdfLoadError } from "../lib/pdf-loader";
  import { DEFAULT_PDF_OPTIONS, isValidPdfOptions, type PdfConvertOptions } from "../lib/pdf-options";
  import { PageRangeError, resolvePageNumbers } from "../lib/pdf-page-range";
  import PdfOptions from "./PdfOptions.svelte";
  import PdfPreview from "./PdfPreview.svelte";

  let { file, onRemove }: { file: File; onRemove: () => void } = $props();

  let status = $state<"loading" | "ready" | "error">("loading");
  let errorKind = $state<"password_protected" | "parse_failed" | null>(null);
  let pdfDocument = $state<PDFDocumentProxy | null>(null);
  let destroyDocument: (() => Promise<void>) | null = null;
  let options = $state<PdfConvertOptions>({ ...DEFAULT_PDF_OPTIONS, crop: { ...DEFAULT_PDF_OPTIONS.crop } });
  let currentPage = $state(1);

  let uploading = $state(false);
  let uploadPercent = $state<number | null>(null);
  let uploadFailedText = $state<string | null>(null);
  let uploadHandleRef: PdfUploadHandle | null = null;

  const pageCount = $derived(pdfDocument?.numPages ?? 0);

  const pagesErrorText = $derived.by(() => {
    if (status !== "ready") return null;
    try {
      resolvePageNumbers(options.pages, pageCount);
      return null;
    } catch (e) {
      if (e instanceof PageRangeError && e.message === "no pages selected") return t("pdf_err_no_pages_selected");
      return t("pdf_err_page_range_invalid");
    }
  });

  const optionsValid = $derived(isValidPdfOptions(options));
  const canSubmit = $derived(status === "ready" && !pagesErrorText && optionsValid && !uploading);

  $effect(() => {
    let cancelled = false;
    status = "loading";
    errorKind = null;
    const current = file;
    void (async () => {
      try {
        const bytes = await current.arrayBuffer();
        if (cancelled) return;
        const loaded = await loadPdfDocument(bytes);
        if (cancelled) { void loaded.destroy(); return; }
        pdfDocument = loaded.document;
        destroyDocument = loaded.destroy;
        currentPage = 1;
        status = "ready";
      } catch (e) {
        if (cancelled) return;
        status = "error";
        errorKind = e instanceof PdfLoadError ? e.kind : "parse_failed";
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => { void destroyDocument?.(); });

  function formatSize(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function loadErrorText(kind: "password_protected" | "parse_failed"): string {
    return kind === "password_protected" ? t("pdf_err_encrypted") : t("pdf_err_parse_failed");
  }

  async function onConvert(): Promise<void> {
    if (!canSubmit) return;
    uploading = true;
    uploadPercent = null;
    uploadFailedText = null;
    const session = submitPdf(file, options, (percent) => { uploadPercent = percent; });
    uploadHandleRef = session.handle;
    const result = await session.done;
    uploadHandleRef = null;
    uploading = false;
    if (result.aborted) {
      uploadPercent = null;
      return; // ユーザーが中断: パネルはそのまま残す
    }
    if (!result.ok) {
      uploadFailedText = t("pdf_err_upload_failed");
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

<div class="pdf-panel">
  <div class="att-row">
    <span class="att-badge">PDF</span>
    <div class="att-info">
      <div class="att-name">{file.name}</div>
      <div class="att-meta">{t("pdf_meta_line")(formatSize(file.size), pageCount || null)}</div>
    </div>
    <button type="button" class="att-x" onclick={onRemove} aria-label={t("pdf_remove_file")}>×</button>
  </div>

  {#if status === "ready" && pdfDocument}
    <PdfPreview {pdfDocument} {options} bind:currentPage {pageCount} />
  {:else if status === "loading"}
    <div class="preview-placeholder"><span class="spinner"></span></div>
  {:else if status === "error" && errorKind}
    <div class="preview-placeholder error-text">{loadErrorText(errorKind)}</div>
  {/if}

  {#if status === "ready"}
    <PdfOptions bind:options {pageCount} />
  {/if}

  {#if uploading}
    <div class="upload-row">
      <div class="upload-bar"><div class="upload-fill" style="width:{uploadPercent ?? 0}%"></div></div>
      <span class="upload-label">{uploadPercent === null ? t("pdf_uploading_indeterminate") : t("pdf_uploading")(uploadPercent)}</span>
      <button type="button" class="secondary" onclick={cancelUpload}>{t("cancel")}</button>
    </div>
  {:else}
    {#if uploadFailedText}<div class="error-text">{uploadFailedText}</div>{/if}
    <!-- pagesErrorText はページ範囲入力欄側（PdfOptions.svelte）で既に表示される。
         ここでは pages 以外（クロップ合計超過など §5.3 のその他バリデーション）で
         optionsValid が false になったケースの理由表示を担う — レビュー指摘: 理由
         表示なしに変換ボタンだけが無効化されるのを防ぐ。 -->
    {#if status === "ready" && !pagesErrorText && !optionsValid}<div class="error-text">{t("pdf_options_invalid")}</div>{/if}
    <button type="button" class="primary convert-btn" disabled={!canSubmit} onclick={() => void onConvert()}>{t("convert")}</button>
  {/if}
</div>

<style>
  .pdf-panel { padding: 20px 0; display: flex; flex-direction: column; gap: 16px; }
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
