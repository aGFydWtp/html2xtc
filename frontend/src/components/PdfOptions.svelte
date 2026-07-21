<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { CROP_AXIS_SUM_MAX, CROP_MAX, MARGIN_PX_MAX, ROTATIONS, THRESHOLD_MAX, type PdfConvertOptions } from "../lib/pdf-options";
  import { isValidPagesSyntax } from "../lib/pdf-page-range";
  import { t } from "../lib/i18n.svelte";

  let { options = $bindable() }: { options: PdfConvertOptions } = $props();

  let advancedOpen = $state(false);

  const pagesInvalid = $derived(options.pages.trim() !== "" ? !isValidPagesSyntax(options.pages) : true);

  // 仕様書 §5.3: 左右・上下それぞれの合計が 0.8 未満でなければならない。各辺の
  // クランプ（0〜CROP_MAX）だけでは検出できない不正状態なので、合計側は別途
  // 表示する（未表示のまま変換ボタンだけが無効化されるのを防ぐ — レビュー指摘）。
  const cropLeftRightInvalid = $derived(options.crop.left + options.crop.right >= CROP_AXIS_SUM_MAX);
  const cropTopBottomInvalid = $derived(options.crop.top + options.crop.bottom >= CROP_AXIS_SUM_MAX);
  const cropSumInvalid = $derived(cropLeftRightInvalid || cropTopBottomInvalid);

  function cropPercent(v: number): number {
    return Math.round(v * 100);
  }
  function setCropPercent(key: "top" | "right" | "bottom" | "left", raw: string): void {
    const pct = Number(raw);
    if (!Number.isFinite(pct)) return;
    const clamped = Math.max(0, Math.min(Math.round(CROP_MAX * 100), pct));
    options.crop = { ...options.crop, [key]: clamped / 100 };
  }
</script>

<div class="pdf-options">
  <div class="field">
    <label class="opt-label" for="pdf-pages">{t("pdf_target_pages")}</label>
    <input
      id="pdf-pages"
      type="text"
      class="text-input"
      class:invalid={pagesInvalid}
      bind:value={options.pages}
      placeholder={t("pdf_pages_hint")}
      inputmode="text"
      autocomplete="off"
      spellcheck="false"
    />
    {#if pagesInvalid}<div class="field-error">{t("pdf_err_page_range_invalid")}</div>{/if}
  </div>

  <div class="field">
    <div class="opt-label">{t("pdf_rotation")}</div>
    <div class="seg">
      {#each ROTATIONS as r (r)}
        <button type="button" aria-pressed={options.rotation === r} onclick={() => (options.rotation = r)}>{r}°</button>
      {/each}
    </div>
  </div>

  <div class="field">
    <div class="opt-label">{t("pdf_fit")}</div>
    <div class="seg">
      <button type="button" aria-pressed={options.fit === "contain"} onclick={() => (options.fit = "contain")}>{t("pdf_fit_contain")}</button>
      <button type="button" aria-pressed={options.fit === "cover"} onclick={() => (options.fit = "cover")}>{t("pdf_fit_cover")}</button>
    </div>
  </div>

  <div class="field">
    <label class="opt-label" for="pdf-margin">{t("pdf_margin")} — {options.marginPx}px</label>
    <input
      id="pdf-margin"
      type="range"
      min="0"
      max={MARGIN_PX_MAX}
      step="1"
      value={options.marginPx}
      oninput={(e) => (options.marginPx = Number(e.currentTarget.value))}
    />
  </div>

  <div class="acc" class:open={advancedOpen}>
    <button
      type="button"
      class="acc-head"
      aria-expanded={advancedOpen}
      onclick={() => (advancedOpen = !advancedOpen)}
    >
      <span class="acc-arrow" aria-hidden="true">{advancedOpen ? "▾" : "▸"}</span>
      <span>{t("pdf_advanced")}</span>
    </button>
    {#if advancedOpen}
      <div class="acc-body">
        <div class="field">
          <div class="opt-label">{t("pdf_crop")}</div>
          <div class="crop-grid">
            <span></span>
            <input type="number" min="0" max={Math.round(CROP_MAX * 100)} class:invalid={cropTopBottomInvalid} value={cropPercent(options.crop.top)} aria-label={t("pdf_crop_top")} oninput={(e) => setCropPercent("top", e.currentTarget.value)} />
            <span></span>
            <input type="number" min="0" max={Math.round(CROP_MAX * 100)} class:invalid={cropLeftRightInvalid} value={cropPercent(options.crop.left)} aria-label={t("pdf_crop_left")} oninput={(e) => setCropPercent("left", e.currentTarget.value)} />
            <span class="crop-center">%</span>
            <input type="number" min="0" max={Math.round(CROP_MAX * 100)} class:invalid={cropLeftRightInvalid} value={cropPercent(options.crop.right)} aria-label={t("pdf_crop_right")} oninput={(e) => setCropPercent("right", e.currentTarget.value)} />
            <span></span>
            <input type="number" min="0" max={Math.round(CROP_MAX * 100)} class:invalid={cropTopBottomInvalid} value={cropPercent(options.crop.bottom)} aria-label={t("pdf_crop_bottom")} oninput={(e) => setCropPercent("bottom", e.currentTarget.value)} />
            <span></span>
          </div>
          {#if cropSumInvalid}<div class="field-error">{t("pdf_crop_sum_invalid")}</div>{/if}
        </div>

        <div class="field">
          <label class="opt-label" for="pdf-threshold">{t("pdf_threshold")} — {options.threshold}</label>
          <input
            id="pdf-threshold"
            type="range"
            min="0"
            max={THRESHOLD_MAX}
            step="1"
            value={options.threshold}
            oninput={(e) => (options.threshold = Number(e.currentTarget.value))}
          />
        </div>

        <div class="field">
          <div class="opt-label">{t("pdf_dither")}</div>
          <div class="seg">
            <button type="button" aria-pressed={options.dither} onclick={() => (options.dither = true)}>{t("pdf_dither_on")}</button>
            <button type="button" aria-pressed={!options.dither} onclick={() => (options.dither = false)}>{t("pdf_dither_off")}</button>
          </div>
        </div>

        {#if options.dither}
          <div class="field">
            <label class="opt-label" for="pdf-dither-strength">{t("pdf_dither_strength")} — {options.ditherStrength.toFixed(2)}</label>
            <input
              id="pdf-dither-strength"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={options.ditherStrength}
              oninput={(e) => (options.ditherStrength = Number(e.currentTarget.value))}
            />
          </div>
        {/if}

        <div class="field">
          <div class="opt-label">{t("pdf_invert")}</div>
          <div class="seg">
            <button type="button" aria-pressed={!options.invert} onclick={() => (options.invert = false)}>{t("pdf_invert_off")}</button>
            <button type="button" aria-pressed={options.invert} onclick={() => (options.invert = true)}>{t("pdf_invert_on")}</button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .pdf-options { display: flex; flex-direction: column; gap: 16px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .opt-label { font-size: 13px; font-weight: 600; color: var(--muted2); letter-spacing: .02em; }
  .text-input {
    padding: 10px 12px; font: inherit; font-size: 15px; border: 1.5px solid var(--ink);
    border-radius: 4px; background: var(--card); color: var(--text);
  }
  .text-input:focus { outline: 2px solid var(--ink); outline-offset: 1px; }
  .text-input.invalid { border-color: var(--error); }
  .field-error { font-size: 12px; color: var(--error); }

  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; align-self: flex-start; }
  .seg button {
    padding: 7px 14px; font: inherit; font-size: 13px; border: 0; background: var(--card);
    color: var(--muted2); cursor: pointer; border-right: 1px solid var(--line);
  }
  .seg button:last-child { border-right: 0; }
  .seg button[aria-pressed="true"] { background: var(--ink); color: var(--ink-text); font-weight: 700; }

  input[type="range"] { width: 100%; accent-color: var(--ink); }

  .acc { border: 1px solid var(--line); border-radius: 4px; background: var(--card); }
  .acc-head {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 14px;
    font: inherit; font-size: 14px; font-weight: 600; border: 0; background: none;
    color: var(--text); cursor: pointer; text-align: left;
  }
  .acc-body { padding: 4px 14px 16px; display: flex; flex-direction: column; gap: 16px; border-top: 1px solid var(--line); }

  .crop-grid { display: grid; grid-template-columns: 44px 44px 44px; gap: 6px; justify-content: start; }
  .crop-grid input[type="number"] {
    width: 44px; padding: 6px; font: inherit; font-size: 13px; text-align: center;
    border: 1px solid var(--line); border-radius: 4px; background: var(--card); color: var(--text);
  }
  .crop-grid input[type="number"].invalid { border-color: var(--error); }
  .crop-center { display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--faint); }
</style>
