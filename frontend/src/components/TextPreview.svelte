<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // 本文プレビュー（実装仕様書 §10.6）。巨大DOMを避けるため初期表示は先頭
  // 50,000文字までとし、「続きを表示」で全文を表示する。表示省略は変換対象へ
  // 影響しない（変換は常に全文を対象とする）。
  import { t } from "../lib/i18n.svelte";
  import { textToParagraphHtml } from "../lib/text-normalize";
  import { BODY_PREVIEW_INITIAL_CHARS, buildBodyPreview } from "../lib/text-preview";

  let { normalizedText }: { normalizedText: string } = $props();

  let expanded = $state(false);

  const preview = $derived(buildBodyPreview(normalizedText, expanded ? Infinity : BODY_PREVIEW_INITIAL_CHARS));
  const bodyHtml = $derived(textToParagraphHtml(preview.visibleText));
</script>

<div class="body-preview">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- bodyHtml は textToParagraphHtml が escapeHtml 済みの本文から生成する固定タグ(<p>/<br>)のみを含む -->
  <div class="body-text">{@html bodyHtml}</div>
  {#if preview.hasMore}
    <button type="button" class="show-more" onclick={() => (expanded = true)}>{t("text_show_more")}</button>
  {/if}
</div>

<style>
  .body-preview {
    max-height: 360px; overflow-y: auto; padding: 16px; background: #fff; border: 1.5px solid var(--ink);
    border-radius: 4px; box-shadow: 3px 3px 0 var(--line);
  }
  .body-text { font-size: 14px; line-height: 1.9; color: #1c1a17; white-space: pre-wrap; overflow-wrap: anywhere; }
  .body-text :global(p) { margin: 0 0 1em; }
  .body-text :global(p:last-child) { margin-bottom: 0; }
  .show-more {
    margin-top: 12px; padding: 8px 18px; font: inherit; font-size: 13px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  .show-more:hover { background: var(--panel); }
</style>
