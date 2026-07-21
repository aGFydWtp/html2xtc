<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { untrack } from "svelte";
  import { CROP_AXIS_SUM_MAX, CROP_MAX, MARGIN_PX_MAX, ROTATIONS, THRESHOLD_MAX, type PdfConvertOptions } from "../lib/pdf-options";
  import { t } from "../lib/i18n.svelte";

  let { options = $bindable(), pageCount }: { options: PdfConvertOptions; pageCount: number } = $props();

  let advancedOpen = $state(false);

  // 仕様書 §5.3: 左右・上下それぞれの合計が 0.8 未満でなければならない。各辺の
  // クランプ（0〜CROP_MAX）だけでは検出できない不正状態なので、合計側は別途
  // 表示する（未表示のまま変換ボタンだけが無効化されるのを防ぐ — レビュー指摘）。
  const cropLeftRightInvalid = $derived(options.crop.left + options.crop.right >= CROP_AXIS_SUM_MAX);
  const cropTopBottomInvalid = $derived(options.crop.top + options.crop.bottom >= CROP_AXIS_SUM_MAX);
  const cropSumInvalid = $derived(cropLeftRightInvalid || cropTopBottomInvalid);

  const fitLabel = $derived(options.fit === "contain" ? t("pdf_fit_contain") : t("pdf_fit_cover"));
  const ditherLabel = $derived(options.dither ? t("pdf_dither_on") : t("pdf_dither_off"));
  const summaryText = $derived(t("pdf_advanced_summary")(fitLabel, options.marginPx, ditherLabel));

  function cropPercent(v: number): number {
    return Math.round(v * 100);
  }
  function setCropPercent(key: "top" | "right" | "bottom" | "left", raw: string): void {
    const pct = Number(raw);
    if (!Number.isFinite(pct)) return;
    const clamped = Math.max(0, Math.min(Math.round(CROP_MAX * 100), pct));
    options.crop = { ...options.crop, [key]: clamped / 100 };
  }

  // --- ページ範囲: UI 上は開始・終了の2つの数値入力のみを見せ、内部で
  // options.pages（"start-end" 文字列。データモデル・API契約は変更しない）を
  // 組み立てる。複雑な構文（"1,3,5-8" 等）は API 側の対応が残るのみで、この
  // UI からは生成しない。
  function parseInitialRange(spec: string, count: number): { start: number; end: number } {
    const trimmed = spec.trim();
    let m = /^(\d+)-(\d+)$/.exec(trimmed);
    if (m) {
      const s = Math.max(1, Math.min(count, Number(m[1])));
      const e = Math.max(s, Math.min(count, Number(m[2])));
      return { start: s, end: e };
    }
    m = /^(\d+)-$/.exec(trimmed);
    if (m) {
      const s = Math.max(1, Math.min(count, Number(m[1])));
      return { start: s, end: count };
    }
    m = /^(\d+)$/.exec(trimmed);
    if (m) {
      const s = Math.max(1, Math.min(count, Number(m[1])));
      return { start: s, end: s };
    }
    return { start: 1, end: count };
  }

  // 初回マウント時の値だけを使う（以後 pageCount/options.pages が変わっても
  // 開始・終了フィールドは追従させない — ユーザー入力を上書きしないため）。
  const initialRange = untrack(() => parseInitialRange(options.pages, pageCount));
  let pageStart = $state(initialRange.start);
  let pageEnd = $state(initialRange.end);

  function commitPageRange(): void {
    let s = Math.max(1, Math.min(pageCount, Math.round(pageStart) || 1));
    let e = Math.max(1, Math.min(pageCount, Math.round(pageEnd) || pageCount));
    if (s > e) [s, e] = [e, s];
    pageStart = s;
    pageEnd = e;
    options.pages = s === 1 && e === pageCount ? "1-" : `${s}-${e}`;
  }
</script>

<div class="pdf-options">
  <div class="acc" class:open={advancedOpen}>
    <button
      type="button"
      class="acc-head"
      aria-expanded={advancedOpen}
      onclick={() => (advancedOpen = !advancedOpen)}
    >
      <span class="acc-title"><span class="acc-arrow" aria-hidden="true">{advancedOpen ? "▾" : "▸"}</span> {t("pdf_advanced")}</span>
      <span class="acc-summary">{summaryText}</span>
    </button>
    {#if advancedOpen}
      <div class="acc-body">
        <div class="pdf-note">{t("pdf_advanced_note")}</div>

        <div class="field">
          <div class="opt-label">{t("pdf_margin")}</div>
          <div class="seg">
            <button type="button" aria-pressed={options.fit === "contain"} onclick={() => (options.fit = "contain")}>{t("pdf_fit_contain")}</button>
            <button type="button" aria-pressed={options.fit === "cover"} onclick={() => (options.fit = "cover")}>{t("pdf_fit_cover")}</button>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <div class="opt-label">{t("pdf_crop")}</div>
            <div class="crop-grid">
              <span></span>
              <input type="number" min="0" max={Math.round(CROP_MAX * 100)} class:invalid={cropTopBottomInvalid} value={cropPercent(options.crop.top)} aria-label={t("pdf_crop_top")} oninput={(e) => setCropPercent("top", e.currentTarget.value)} />
              <span></span>
              <input type="number" min="0" max={Math.round(CROP_MAX * 100)} class:invalid={cropLeftRightInvalid} value={cropPercent(options.crop.left)} aria-label={t("pdf_crop_left")} oninput={(e) => setCropPercent("left", e.currentTarget.value)} />
              <span class="crop-center" aria-hidden="true"></span>
              <input type="number" min="0" max={Math.round(CROP_MAX * 100)} class:invalid={cropLeftRightInvalid} value={cropPercent(options.crop.right)} aria-label={t("pdf_crop_right")} oninput={(e) => setCropPercent("right", e.currentTarget.value)} />
              <span></span>
              <input type="number" min="0" max={Math.round(CROP_MAX * 100)} class:invalid={cropTopBottomInvalid} value={cropPercent(options.crop.bottom)} aria-label={t("pdf_crop_bottom")} oninput={(e) => setCropPercent("bottom", e.currentTarget.value)} />
              <span></span>
            </div>
            {#if cropSumInvalid}<div class="field-error">{t("pdf_crop_sum_invalid")}</div>{/if}
          </div>

          <div class="field">
            <label class="opt-label" for="pdf-output-margin">{t("pdf_output_margin")}</label>
            <div class="margin-input-row">
              <input
                id="pdf-output-margin"
                type="number"
                min="0"
                max={MARGIN_PX_MAX}
                value={options.marginPx}
                oninput={(e) => {
                  const v = Number(e.currentTarget.value);
                  if (Number.isFinite(v)) options.marginPx = Math.max(0, Math.min(MARGIN_PX_MAX, Math.round(v)));
                }}
              />
              <span class="unit">px</span>
            </div>
          </div>
        </div>

        <div class="field">
          <div class="opt-label">{t("pdf_threshold")}</div>
          <div class="th-row">
            <input
              id="pdf-threshold"
              type="range"
              min="0"
              max={THRESHOLD_MAX}
              step="1"
              value={options.threshold}
              oninput={(e) => (options.threshold = Number(e.currentTarget.value))}
            />
            <span class="th-val">{options.threshold}</span>
          </div>
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
          <div class="opt-label">{t("pdf_target_pages")}</div>
          <div class="pages-row">
            <input
              type="number"
              min="1"
              max={pageCount}
              bind:value={pageStart}
              aria-label={t("pdf_page_start")}
              onchange={commitPageRange}
            />
            <span class="pages-sep">–</span>
            <input
              type="number"
              min="1"
              max={pageCount}
              bind:value={pageEnd}
              aria-label={t("pdf_page_end")}
              onchange={commitPageRange}
            />
          </div>
        </div>

        <div class="field">
          <div class="opt-label">{t("pdf_invert")}</div>
          <div class="seg">
            <button type="button" aria-pressed={!options.invert} onclick={() => (options.invert = false)}>{t("pdf_invert_off")}</button>
            <button type="button" aria-pressed={options.invert} onclick={() => (options.invert = true)}>{t("pdf_invert_on")}</button>
          </div>
        </div>

        <div class="field">
          <div class="opt-label">{t("pdf_rotation")}</div>
          <div class="seg">
            {#each ROTATIONS as r (r)}
              <button type="button" aria-pressed={options.rotation === r} onclick={() => (options.rotation = r)}>{r}°</button>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .pdf-options { display: flex; flex-direction: column; gap: 16px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-row { display: flex; flex-wrap: wrap; gap: 20px; }
  .opt-label { font-size: 13px; font-weight: 600; color: var(--muted2); letter-spacing: .02em; }
  .field-error { font-size: 12px; color: var(--error); }

  .pdf-note {
    padding: 10px 14px; background: var(--panel); border-radius: 4px; font-size: 12px;
    color: var(--muted2); line-height: 1.7;
  }

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
    display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%;
    padding: 12px 16px; font: inherit; font-size: 14px; font-weight: 700; border: 0; background: none;
    color: var(--text); cursor: pointer; text-align: left;
  }
  .acc-title { display: flex; align-items: center; gap: 6px; }
  .acc-summary { font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acc-body { padding: 4px 16px 16px; display: flex; flex-direction: column; gap: 16px; border-top: 1px solid var(--line); }

  .crop-grid { display: grid; grid-template-columns: 44px 44px 44px; gap: 6px; justify-content: start; }
  .crop-grid input[type="number"] {
    width: 44px; padding: 6px; font: inherit; font-size: 13px; text-align: center;
    border: 1px solid var(--line); border-radius: 4px; background: var(--card); color: var(--text);
  }
  .crop-grid input[type="number"].invalid { border-color: var(--error); }
  .crop-center { display: block; height: 33px; border: 1px dashed var(--line); border-radius: 4px; background: var(--bg); }

  .margin-input-row { display: flex; align-items: center; gap: 8px; }
  .margin-input-row input[type="number"] {
    width: 64px; padding: 7px 4px; font: inherit; font-size: 14px; text-align: center;
    border: 1px solid var(--line); border-radius: 4px; background: var(--card); color: var(--text);
  }
  .margin-input-row .unit { font-family: var(--mono); font-size: 12px; color: var(--muted); }

  .th-row { display: flex; align-items: center; gap: 10px; }
  .th-row input[type="range"] { flex: 1; }
  .th-val { font-family: var(--mono); font-size: 12px; color: var(--muted2); flex: none; width: 30px; text-align: right; }

  .pages-row { display: flex; align-items: center; gap: 8px; }
  .pages-row input[type="number"] {
    width: 62px; padding: 8px 4px; font-family: var(--mono); font-size: 14px; text-align: center;
    border: 1px solid var(--line); border-radius: 4px; background: var(--card); color: var(--text);
  }
  .pages-sep { color: var(--muted); }
</style>
