<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { t } from "../lib/i18n.svelte";
  import type { EncodingDetectionResult } from "../lib/text-decode";
  import { FONT_CANDIDATES, setTextLayout, type TextConvertOptions } from "../lib/text-options";

  let {
    options = $bindable(),
    detectionResult,
    hasEncodingError = false,
  }: { options: TextConvertOptions; detectionResult: EncodingDetectionResult | null; hasEncodingError?: boolean } = $props();

  let advancedOpen = $state(false);

  // 文字コード選択がこのアコーディオン内にあるため、デコード失敗時（文字コードを
  // 変えて復旧する必要がある場面）は自動的に展開する。復旧後に自動で閉じることは
  // しない（ユーザーが他の設定も確認できるように開いたままにする）。
  $effect(() => {
    if (hasEncodingError) advancedOpen = true;
  });

  const layoutLabel = $derived(options.layout === "vertical" ? t("text_layout_vertical") : t("text_layout_horizontal"));
  const summaryText = $derived(t("text_options_summary")(layoutLabel, options.fontSizePx));

  function setMargin(key: "top" | "right" | "bottom" | "left", raw: string): void {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    options.margins = { ...options.margins, [key]: Math.max(0, Math.min(120, Math.round(v))) };
  }

  function detectedEncodingLabel(result: EncodingDetectionResult): string {
    return result.encoding === "utf-8" ? t("text_encoding_option_utf8") : t("text_encoding_option_shift_jis");
  }
</script>

<div class="text-options">
  <div class="acc" class:open={advancedOpen}>
    <button
      type="button"
      class="acc-head"
      class:acc-head-error={hasEncodingError}
      aria-expanded={advancedOpen}
      onclick={() => (advancedOpen = !advancedOpen)}
    >
      <span class="acc-title">
        <span class="acc-arrow" aria-hidden="true">{advancedOpen ? "▾" : "▸"}</span> {t("text_options_heading")}
        {#if hasEncodingError}<span class="acc-error-badge" aria-hidden="true">!</span>{/if}
      </span>
      <span class="acc-summary">{summaryText}</span>
    </button>
    {#if advancedOpen}
      <div class="acc-body">
        <div class="field-row">
          <div class="field">
            <div class="opt-label">{t("text_layout_label")}</div>
            <div class="seg">
              <button type="button" aria-pressed={options.layout === "horizontal"} onclick={() => (options = setTextLayout(options, "horizontal"))}>{t("text_layout_horizontal")}</button>
              <button type="button" aria-pressed={options.layout === "vertical"} onclick={() => (options = setTextLayout(options, "vertical"))}>{t("text_layout_vertical")}</button>
            </div>
          </div>

          <div class="field">
            <label class="opt-label" for="text-font">{t("text_font_label")}</label>
            <select id="text-font" bind:value={options.font}>
              {#each FONT_CANDIDATES as candidate (candidate.family)}
                <option value={candidate.family}>{candidate.label}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label class="opt-label" for="text-font-size">{t("text_font_size_label")} — {options.fontSizePx}px</label>
            <input
              id="text-font-size"
              type="range"
              min="12"
              max="32"
              step="1"
              value={options.fontSizePx}
              oninput={(e) => (options.fontSizePx = Number(e.currentTarget.value))}
            />
          </div>
          <div class="field">
            <label class="opt-label" for="text-line-height">{t("text_line_height_label")} — {options.lineHeight.toFixed(1)}</label>
            <input
              id="text-line-height"
              type="range"
              min="1.2"
              max="2.5"
              step="0.1"
              value={options.lineHeight}
              oninput={(e) => (options.lineHeight = Number(e.currentTarget.value))}
            />
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label class="opt-label" for="text-paragraph-spacing">{t("text_paragraph_spacing_label")} — {options.paragraphSpacingEm.toFixed(1)}em</label>
            <input
              id="text-paragraph-spacing"
              type="range"
              min="0"
              max="3"
              step="0.1"
              value={options.paragraphSpacingEm}
              oninput={(e) => (options.paragraphSpacingEm = Number(e.currentTarget.value))}
            />
          </div>
          <div class="field">
            <div class="opt-label">{t("text_align_label")}</div>
            <div class="seg">
              <button type="button" aria-pressed={options.textAlign === "start"} onclick={() => (options.textAlign = "start")}>{t("text_align_start")}</button>
              <button type="button" aria-pressed={options.textAlign === "justify"} onclick={() => (options.textAlign = "justify")}>{t("text_align_justify")}</button>
            </div>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label class="opt-label" for="text-max-blank-lines">{t("text_max_blank_lines_label")} — {options.maxConsecutiveBlankLines}</label>
            <input
              id="text-max-blank-lines"
              type="range"
              min="0"
              max="5"
              step="1"
              value={options.maxConsecutiveBlankLines}
              oninput={(e) => (options.maxConsecutiveBlankLines = Number(e.currentTarget.value))}
            />
          </div>
          <div class="field">
            <div class="opt-label">{t("text_preserve_spaces_label")}</div>
            <div class="seg">
              <button type="button" aria-pressed={!options.preserveSpaces} onclick={() => (options.preserveSpaces = false)}>{t("text_preserve_spaces_off")}</button>
              <button type="button" aria-pressed={options.preserveSpaces} onclick={() => (options.preserveSpaces = true)}>{t("text_preserve_spaces_on")}</button>
            </div>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <div class="opt-label">{t("text_margin_label")}</div>
            <div class="margin-grid">
              <span></span>
              <input type="number" min="0" max="120" value={options.margins.top} aria-label={t("text_margin_top")} oninput={(e) => setMargin("top", e.currentTarget.value)} />
              <span></span>
              <input type="number" min="0" max="120" value={options.margins.left} aria-label={t("text_margin_left")} oninput={(e) => setMargin("left", e.currentTarget.value)} />
              <span class="margin-center" aria-hidden="true"></span>
              <input type="number" min="0" max="120" value={options.margins.right} aria-label={t("text_margin_right")} oninput={(e) => setMargin("right", e.currentTarget.value)} />
              <span></span>
              <input type="number" min="0" max="120" value={options.margins.bottom} aria-label={t("text_margin_bottom")} oninput={(e) => setMargin("bottom", e.currentTarget.value)} />
              <span></span>
            </div>
          </div>

          <div class="field">
            <label class="opt-label" for="text-encoding">{t("text_encoding_label")}</label>
            <select id="text-encoding" bind:value={options.encoding}>
              <option value="auto">{options.encoding === "auto" && detectionResult ? t("text_encoding_detected")(detectedEncodingLabel(detectionResult)) : t("text_encoding_option_auto")}</option>
              <option value="utf-8">{t("text_encoding_option_utf8")}</option>
              <option value="shift_jis">{t("text_encoding_option_shift_jis")}</option>
            </select>
          </div>
        </div>

        <div class="field">
          <div class="opt-label">{t("text_join_lines_label")}</div>
          <div class="seg">
            <button type="button" aria-pressed={options.joinHardWrappedLines} onclick={() => (options.joinHardWrappedLines = true)}>{t("text_join_lines_on")}</button>
            <button type="button" aria-pressed={!options.joinHardWrappedLines} onclick={() => (options.joinHardWrappedLines = false)}>{t("text_join_lines_off")}</button>
          </div>
          <p class="field-note">{t("text_join_lines_note")}</p>
        </div>

        <div class="bib-heading">{t("text_bibliographic_heading")}</div>

        <div class="field">
          <label class="opt-label" for="text-title">{t("text_title_label")}</label>
          <input id="text-title" type="text" maxlength="100" bind:value={options.title} />
        </div>

        <div class="field">
          <label class="opt-label" for="text-author">{t("text_author_label")}</label>
          <input id="text-author" type="text" maxlength="100" bind:value={options.author} />
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .text-options { display: flex; flex-direction: column; gap: 16px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-row { display: flex; flex-wrap: wrap; gap: 20px; }
  .field-row .field { flex: 1; min-width: 160px; }
  .opt-label { font-size: 13px; font-weight: 600; color: var(--muted2); letter-spacing: .02em; }
  .field-note { margin: 2px 0 0; font-size: 12px; color: var(--muted); }

  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; align-self: flex-start; }
  .seg button {
    padding: 7px 14px; font: inherit; font-size: 13px; border: 0; background: var(--card);
    color: var(--muted2); cursor: pointer; border-right: 1px solid var(--line);
  }
  .seg button:last-child { border-right: 0; }
  .seg button[aria-pressed="true"] { background: var(--ink); color: var(--ink-text); font-weight: 700; }

  select {
    padding: 8px 10px; font: inherit; font-size: 14px; border: 1px solid var(--line); border-radius: 4px;
    background: var(--card); color: var(--text); align-self: flex-start; min-width: 200px;
  }

  input[type="range"] { width: 100%; accent-color: var(--ink); }

  .margin-grid { display: grid; grid-template-columns: 44px 44px 44px; gap: 6px; justify-content: start; }
  .margin-grid input[type="number"] {
    width: 44px; padding: 6px; font: inherit; font-size: 13px; text-align: center;
    border: 1px solid var(--line); border-radius: 4px; background: var(--card); color: var(--text);
  }
  .margin-center { display: block; height: 33px; border: 1px dashed var(--line); border-radius: 4px; background: var(--bg); }

  .acc { border: 1px solid var(--line); border-radius: 4px; background: var(--card); }
  .acc-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%;
    padding: 12px 16px; font: inherit; font-size: 14px; font-weight: 700; border: 0; background: none;
    color: var(--text); cursor: pointer; text-align: left;
  }
  .acc-title { display: flex; align-items: center; gap: 6px; }
  .acc-summary { font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acc-body { padding: 4px 16px 16px; display: flex; flex-direction: column; gap: 16px; border-top: 1px solid var(--line); }

  .acc-head-error { color: var(--error); }
  .acc-error-badge {
    display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
    border-radius: 50%; background: var(--error); color: #fff; font-size: 11px; font-weight: 700;
  }

  .bib-heading { font-size: 13px; font-weight: 700; color: var(--muted2); margin-top: 4px; }
  input[type="text"] {
    padding: 8px 10px; font: inherit; font-size: 14px; border: 1px solid var(--line); border-radius: 4px;
    background: var(--card); color: var(--text);
  }
</style>
