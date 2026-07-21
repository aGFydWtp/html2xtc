<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // X3ページプレビュー（実装仕様書 §9.1, §9.3-9.7, §10.7）。528×792比率のDOMプレビュー
  // に組版CSSを適用し、先頭ページ相当だけを表示する（厳密な改ページ計算はしない）。
  import { onMount } from "svelte";
  import { t } from "../lib/i18n.svelte";
  import { escapeHtml } from "../lib/text-normalize";
  import { buildX3PreviewBodyHtml } from "../lib/text-preview";
  import { FONT_CANDIDATES, type TextConvertOptions } from "../lib/text-options";

  let { normalizedText, options }: { normalizedText: string; options: TextConvertOptions } = $props();

  const bodyHtml = $derived(buildX3PreviewBodyHtml(normalizedText));
  const hasHeader = $derived(options.title.trim() !== "" || options.author.trim() !== "");

  // フォールバック総称ファミリはサーバー(src/text-html.ts の fontStack)と
  // 揃える: 縦書きは日本語文芸書に合うserif、横書きは既定のsans-serif。
  const fallbackFamily = $derived(options.layout === "vertical" ? "serif" : "sans-serif");

  const pageStyle = $derived(
    [
      `--font-family: "${options.font}", ${fallbackFamily}`,
      `--font-size: ${options.fontSizePx}px`,
      `--line-height: ${options.lineHeight}`,
      `--paragraph-spacing: ${options.paragraphSpacingEm}em`,
      `--margin-top: ${options.margins.top}px`,
      `--margin-right: ${options.margins.right}px`,
      `--margin-bottom: ${options.margins.bottom}px`,
      `--margin-left: ${options.margins.left}px`,
    ].join("; "),
  );

  // プレビュー表示専用。変換自体はサーバー側で処理するため、ここでロードした
  // フォントは目安表示にのみ使う（ユーザー指示: プレビューにはGoogle Fontsをロード）。
  const loadedFontLinks = new Set<string>();
  function ensureFontLoaded(family: string): void {
    if (loadedFontLinks.has(family)) return;
    const candidate = FONT_CANDIDATES.find((f) => f.family === family);
    if (!candidate) return;
    const href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@400;700&display=swap`;
    if (document.querySelector(`link[data-text-preview-font="${family}"]`)) {
      loadedFontLinks.add(family);
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.textPreviewFont = family;
    document.head.appendChild(link);
    loadedFontLinks.add(family);
  }

  onMount(() => {
    ensureFontLoaded(options.font);
  });
  $effect(() => {
    ensureFontLoaded(options.font);
  });
</script>

<div class="x3-preview">
  <div
    class="x3-page"
    class:vertical={options.layout === "vertical"}
    class:justify={options.textAlign === "justify"}
    class:preserve={options.preserveSpaces}
    style={pageStyle}
  >
    {#if hasHeader}
      <header class="book-header">
        {#if options.title.trim()}<h1>{escapeHtml(options.title.trim())}</h1>{/if}
        {#if options.author.trim()}<p class="author">{escapeHtml(options.author.trim())}</p>{/if}
      </header>
    {/if}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- bodyHtml は escapeHtml 済みの本文から生成する固定タグ(<p>/<br>)のみを含む -->
    <article class="content">{@html bodyHtml}</article>
  </div>
  <p class="x3-note">{t("text_preview_note")}</p>
</div>

<style>
  .x3-preview { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .x3-page {
    width: 100%; max-width: 264px; aspect-ratio: 528 / 792; background: #fff; color: #000;
    border: 1.5px solid var(--ink); border-radius: 4px; box-shadow: 3px 3px 0 var(--line);
    overflow: hidden; padding: var(--margin-top) var(--margin-right) var(--margin-bottom) var(--margin-left);
    box-sizing: border-box;
    font-family: var(--font-family);
    font-size: calc(var(--font-size) * 0.5);
    line-height: var(--line-height);
  }
  .book-header { margin-bottom: 1em; }
  .book-header h1 { margin: 0 0 .3em; font-size: 1.3em; font-weight: 700; }
  .book-header .author { margin: 0; font-size: .85em; color: #444; }
  .x3-page .content {
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    overflow-wrap: anywhere;
    height: 100%;
  }
  .x3-page.vertical .content { writing-mode: vertical-rl; }
  .x3-page.justify .content { text-align: justify; text-justify: inter-character; }
  .x3-page.preserve .content { white-space: pre-wrap; tab-size: 4; }
  .x3-page :global(.content p) { margin: 0 0 var(--paragraph-spacing); }
  .x3-note { max-width: 264px; margin: 0; font-size: 12px; color: var(--muted); line-height: 1.7; text-align: center; }
</style>
