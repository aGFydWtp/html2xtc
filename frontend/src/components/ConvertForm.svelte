<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { aozora } from "../lib/aozora.svelte";
  import { authStore } from "../lib/auth.svelte";
  import { submitUrl, submitting } from "../lib/convert.svelte";
  import { EpubFileValidationError, validateEpubFile } from "../lib/epub-file-validate";
  import { t } from "../lib/i18n.svelte";
  import { detectInputFileKind } from "../lib/input-file-kind";
  import { opdsStore } from "../lib/opds.svelte";
  import { PdfFileValidationError, validatePdfFile } from "../lib/pdf-file-validate";
  import { publicConfigStore } from "../lib/publicConfig.svelte";
  import { targetDeviceStore } from "../lib/targetDevice.svelte";
  import { TextFileValidationError, validateTextFile } from "../lib/text-file-validate";
  import EpubInputPanel from "./EpubInputPanel.svelte";
  import FileDropZone from "./FileDropZone.svelte";
  import PdfInputPanel from "./PdfInputPanel.svelte";
  import TextInputPanel from "./TextInputPanel.svelte";

  let url = $state("");
  let pdfFile = $state<File | null>(null);
  let txtFile = $state<File | null>(null);
  let epubFile = $state<File | null>(null);
  let fileError = $state<string | null>(null);

  function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    void submitUrl(url);
  }

  function pdfFileErrorText(kind: PdfFileValidationError["kind"]): string {
    switch (kind) {
      case "too_large": return t("pdf_err_too_large");
      case "magic_missing": return t("pdf_err_parse_failed");
      default: return t("pdf_err_not_pdf");
    }
  }

  function textFileErrorText(kind: TextFileValidationError["kind"]): string {
    switch (kind) {
      case "too_large": return t("text_err_too_large");
      case "empty": return t("text_err_empty");
      case "utf16": return t("text_err_utf16");
      case "binary": return t("text_err_binary");
      default: return t("text_err_not_txt");
    }
  }

  function epubFileErrorText(kind: EpubFileValidationError["kind"]): string {
    switch (kind) {
      case "too_large": return t("epub_err_too_large");
      case "empty": return t("epub_err_empty");
      case "magic_missing": return t("epub_err_invalid_zip");
      default: return t("epub_err_not_epub");
    }
  }

  // ファイル種別の判定（enum化、仕様書 §16.2）自体は input-file-kind.ts の純粋関数
  // detectInputFileKind に切り出してある（ドロップゾーンはPDF/TXT/EPUB共用。複数
  // ファイルは受け付けない）。ここではその結果に応じてクライアント検証・パネルへ
  // 分岐するだけ。
  async function onFileSelected(file: File): Promise<void> {
    fileError = null;
    const kind = detectInputFileKind(file);
    if (kind === "epub") {
      try {
        await validateEpubFile(file);
        epubFile = file;
      } catch (e) {
        fileError = e instanceof EpubFileValidationError ? epubFileErrorText(e.kind) : t("epub_err_not_epub");
      }
      return;
    }
    if (kind === "pdf") {
      try {
        await validatePdfFile(file);
        pdfFile = file;
      } catch (e) {
        fileError = e instanceof PdfFileValidationError ? pdfFileErrorText(e.kind) : t("pdf_err_not_pdf");
      }
      return;
    }
    if (kind === "text") {
      try {
        await validateTextFile(file);
        txtFile = file;
      } catch (e) {
        fileError = e instanceof TextFileValidationError ? textFileErrorText(e.kind) : t("text_err_not_txt");
      }
      return;
    }
    fileError = t("file_err_unsupported_type");
  }

  function onRemoveFile(): void {
    pdfFile = null;
    txtFile = null;
    epubFile = null;
    fileError = null;
  }
</script>

<section class="convert">
  <p class="intro">{t("intro")}</p>
  {#if pdfFile}
    <PdfInputPanel file={pdfFile} onRemove={onRemoveFile} />
  {:else if txtFile}
    <TextInputPanel file={txtFile} onRemove={onRemoveFile} />
  {:else if epubFile}
    <EpubInputPanel file={epubFile} onRemove={onRemoveFile} />
  {:else}
    <div class="device-toggle" role="group" aria-label={t("device_toggle_label")}>
      <div class="seg-pill">
        <button
          type="button"
          aria-pressed={targetDeviceStore.device === "x3"}
          onclick={() => targetDeviceStore.set("x3")}
        >X3</button>
        <button
          type="button"
          aria-pressed={targetDeviceStore.device === "x4"}
          onclick={() => targetDeviceStore.set("x4")}
        >X4</button>
      </div>
    </div>
    <div class="form-note"><span>{t("agree_before")}</span><a href="/about#terms">{t("agree_link")}</a><span>{t("agree_after")}</span></div>
    <FileDropZone onFileSelected={(f) => void onFileSelected(f)}>
      <form {onsubmit}>
        <div class="input-row">
          <input
            type="url"
            bind:value={url}
            required
            placeholder="https://example.com/article"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="primary" type="submit" disabled={submitting.busy}>{t("convert")}</button>
        </div>
      </form>
      {#snippet below()}
        <div class="source-buttons">
          <button type="button" class="link" onclick={() => aozora.show()}>{t("aozora_open")}</button>
          {#if authStore.ready && authStore.account && publicConfigStore.opdsImportEnabled}
            <button type="button" class="link" onclick={() => void opdsStore.openMemlane()}>{t("memlane_open")}</button>
          {/if}
        </div>
      {/snippet}
    </FileDropZone>
    {#if fileError}<div class="error-text">{fileError}</div>{/if}
    {#if opdsStore.importSummary && opdsStore.importSummary.failedCount > 0}
      <div class="error-text">{t("memlane_import_partial_failed")(opdsStore.importSummary.failedCount)}</div>
    {/if}
  {/if}
</section>

<style>
  section.convert { padding: 30px 0 30px; }
  .intro { margin: 0 0 16px; color: var(--muted2); line-height: 1.8; }
  .device-toggle { display: flex; justify-content: center; margin-bottom: 16px; }
  .seg-pill {
    display: inline-flex; border: 1.5px solid var(--ink); border-radius: 999px;
    overflow: hidden; background: var(--card);
  }
  .seg-pill button {
    padding: 7px 22px; font-family: var(--mono); font-size: 14px; border: 0;
    background: var(--card); color: var(--muted); cursor: pointer;
  }
  .seg-pill button[aria-pressed="true"] {
    background: var(--ink); color: var(--ink-text); font-weight: 600; border-radius: 999px;
  }
  .seg-pill button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  form .input-row {
    display: flex; border: 1.5px solid var(--ink); background: var(--card);
    border-radius: 4px; overflow: hidden;
  }
  input[type="url"] {
    flex: 1; min-width: 0; padding: 14px 16px; font: inherit; font-size: 16px;
    border: 0; background: none; color: var(--text);
  }
  input[type="url"]::placeholder { color: var(--faint); }
  input[type="url"]:focus { outline: none; }
  form .input-row:focus-within { outline: 2px solid var(--ink); outline-offset: 1px; }
  button.primary {
    padding: 14px 26px; font: inherit; font-size: 16px; font-weight: 700; letter-spacing: .1em;
    border: 0; background: var(--ink); color: var(--ink-text); cursor: pointer; white-space: nowrap;
  }
  button.primary:disabled { opacity: .55; cursor: default; }
  .form-note { font-size: 14px; color: var(--muted); margin: 0 0 10px; }
  .source-buttons {
    margin-top: 16px; display: flex; justify-content: center; align-items: center;
    gap: 10px; flex-wrap: wrap;
  }
  button.link {
    padding: 6px 6px; font: inherit; font-size: 14px; font-weight: 500;
    border: 0; background: none; color: var(--muted2); text-decoration: underline;
    cursor: pointer;
  }
  button.link:hover { color: var(--ink); }
  button.link:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

  @media (max-width: 600px) {
    .source-buttons { flex-direction: column; gap: 0; }
  }
</style>
