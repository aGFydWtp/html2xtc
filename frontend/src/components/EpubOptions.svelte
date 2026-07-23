<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { FONT_SIZE_PX_MAX, FONT_SIZE_PX_MIN, MARGIN_PX_MAX, MARGIN_PX_MIN, type EpubConvertOptions } from "../lib/epub-options";
  import { t } from "../lib/i18n.svelte";
  import { FONT_CANDIDATES } from "../lib/text-options";
  import FontSelect from "./FontSelect.svelte";

  let { options = $bindable() }: { options: EpubConvertOptions } = $props();
</script>

<div class="epub-options">
  <div class="field-row">
    <div class="field">
      <div class="opt-label">{t("epub_layout_label")}</div>
      <div class="seg">
        <button type="button" aria-pressed={options.layout === "auto"} onclick={() => (options.layout = "auto")}>{t("epub_layout_auto")}</button>
        <button type="button" aria-pressed={options.layout === "horizontal"} onclick={() => (options.layout = "horizontal")}>{t("epub_layout_horizontal")}</button>
        <button type="button" aria-pressed={options.layout === "vertical"} onclick={() => (options.layout = "vertical")}>{t("epub_layout_vertical")}</button>
      </div>
    </div>

    <div class="field">
      <label class="opt-label" for="epub-font">{t("epub_font_label")}</label>
      <FontSelect id="epub-font" candidates={FONT_CANDIDATES} bind:value={options.font} />
    </div>
  </div>

  <div class="field-row">
    <div class="field">
      <label class="opt-label" for="epub-font-size">{t("epub_font_size_label")} — {options.fontSizePx}px</label>
      <input
        id="epub-font-size"
        type="range"
        min={FONT_SIZE_PX_MIN}
        max={FONT_SIZE_PX_MAX}
        step="1"
        value={options.fontSizePx}
        oninput={(e) => (options.fontSizePx = Number(e.currentTarget.value))}
      />
    </div>

    <div class="field">
      <label class="opt-label" for="epub-margin">{t("epub_margin_label")}</label>
      <div class="margin-input-row">
        <input
          id="epub-margin"
          type="number"
          min={MARGIN_PX_MIN}
          max={MARGIN_PX_MAX}
          value={options.marginPx}
          oninput={(e) => {
            const v = Number(e.currentTarget.value);
            if (Number.isFinite(v)) options.marginPx = Math.max(MARGIN_PX_MIN, Math.min(MARGIN_PX_MAX, Math.round(v)));
          }}
        />
        <span class="unit">px</span>
      </div>
    </div>
  </div>

  <div class="field-row">
    <div class="field">
      <div class="opt-label">{t("epub_chapter_page_break_label")}</div>
      <div class="seg">
        <button type="button" aria-pressed={options.chapterPageBreak} onclick={() => (options.chapterPageBreak = true)}>{t("epub_chapter_page_break_on")}</button>
        <button type="button" aria-pressed={!options.chapterPageBreak} onclick={() => (options.chapterPageBreak = false)}>{t("epub_chapter_page_break_off")}</button>
      </div>
    </div>

    <div class="field">
      <div class="opt-label">{t("epub_include_cover_label")}</div>
      <div class="seg">
        <button type="button" aria-pressed={options.includeCover} onclick={() => (options.includeCover = true)}>{t("epub_include_cover_on")}</button>
        <button type="button" aria-pressed={!options.includeCover} onclick={() => (options.includeCover = false)}>{t("epub_include_cover_off")}</button>
      </div>
    </div>
  </div>

  <div class="field">
    <div class="opt-label">{t("epub_include_toc_label")}</div>
    <div class="seg">
      <button type="button" aria-pressed={options.includeTableOfContents} onclick={() => (options.includeTableOfContents = true)}>{t("epub_include_toc_on")}</button>
      <button type="button" aria-pressed={!options.includeTableOfContents} onclick={() => (options.includeTableOfContents = false)}>{t("epub_include_toc_off")}</button>
    </div>
  </div>
</div>

<style>
  .epub-options { display: flex; flex-direction: column; gap: 16px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-row { display: flex; flex-wrap: wrap; gap: 20px; }
  .opt-label { font-size: 13px; font-weight: 600; color: var(--muted2); letter-spacing: .02em; }

  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; align-self: flex-start; }
  .seg button {
    padding: 7px 14px; font: inherit; font-size: 13px; border: 0; background: var(--card);
    color: var(--muted2); cursor: pointer; border-right: 1px solid var(--line);
  }
  .seg button:last-child { border-right: 0; }
  .seg button[aria-pressed="true"] { background: var(--ink); color: var(--ink-text); font-weight: 700; }

  input[type="range"] { width: 100%; accent-color: var(--ink); }

  .margin-input-row { display: flex; align-items: center; gap: 8px; }
  .margin-input-row input[type="number"] {
    width: 64px; padding: 7px 4px; font: inherit; font-size: 14px; text-align: center;
    border: 1px solid var(--line); border-radius: 4px; background: var(--card); color: var(--text);
  }
  .margin-input-row .unit { font-family: var(--mono); font-size: 12px; color: var(--muted); }
</style>
