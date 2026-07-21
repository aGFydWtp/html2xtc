<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { aozora } from "../lib/aozora.svelte";
  import { submitUrl, submitting } from "../lib/convert.svelte";
  import { t } from "../lib/i18n.svelte";
  import { PdfFileValidationError, validatePdfFile } from "../lib/pdf-file-validate";
  import PdfDropZone from "./PdfDropZone.svelte";
  import PdfInputPanel from "./PdfInputPanel.svelte";

  let url = $state("");
  let pdfFile = $state<File | null>(null);
  let fileError = $state<string | null>(null);

  function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    void submitUrl(url);
  }

  function fileErrorText(kind: PdfFileValidationError["kind"]): string {
    switch (kind) {
      case "too_large": return t("pdf_err_too_large");
      case "magic_missing": return t("pdf_err_parse_failed");
      default: return t("pdf_err_not_pdf");
    }
  }

  async function onFileSelected(file: File): Promise<void> {
    fileError = null;
    try {
      await validatePdfFile(file);
      pdfFile = file;
    } catch (e) {
      fileError = e instanceof PdfFileValidationError ? fileErrorText(e.kind) : t("pdf_err_not_pdf");
    }
  }

  function onRemoveFile(): void {
    pdfFile = null;
    fileError = null;
  }
</script>

<section class="convert">
  <p class="intro">{t("intro")}</p>
  {#if pdfFile}
    <PdfInputPanel file={pdfFile} onRemove={onRemoveFile} />
  {:else}
    <PdfDropZone onFileSelected={(f) => void onFileSelected(f)}>
      <form {onsubmit}>
        <div class="form-note"><span>{t("agree_before")}</span><a href="/about#terms">{t("agree_link")}</a><span>{t("agree_after")}</span></div>
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
    </PdfDropZone>
    {#if fileError}<div class="error-text">{fileError}</div>{/if}
    <div class="aozora-open-row">
      <button type="button" class="secondary" onclick={() => aozora.show()}>{t("aozora_open")}</button>
    </div>
  {/if}
</section>

<style>
  section.convert { padding: 30px 0 30px; }
  .intro { margin: 0 0 16px; color: var(--muted2); line-height: 1.8; }
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
  .aozora-open-row { margin-top: 16px; }
  button.secondary {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  button.secondary:hover { background: var(--panel); }
</style>
