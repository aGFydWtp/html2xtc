<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { t } from "../lib/i18n.svelte";

  let { onFileSelected, children }: { onFileSelected: (file: File) => void; children: Snippet } = $props();

  let dragActive = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  function onDragEnter(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragActive = true;
  }
  function onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
  }
  function onDragLeave(event: DragEvent): void {
    event.preventDefault();
    dragActive = false;
  }
  function onDrop(event: DragEvent): void {
    event.preventDefault();
    dragActive = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) onFileSelected(file);
  }
  function onPick(): void {
    fileInput?.click();
  }
  function onFileInputChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) onFileSelected(file);
    input.value = ""; // 同じファイルを連続で選び直せるようにする
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -- ドラッグ&ドロップは補助手段。同じ操作は下の「ファイルを選択」ボタンからも可能。 -->
<div
  class="zone"
  class:drag={dragActive}
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {@render children()}
  <div class="zone-hint">
    <span>{t("pdf_or_drop")}</span>
    <button type="button" class="linkish" onclick={onPick}>{t("pdf_pick_file")}</button>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <input bind:this={fileInput} type="file" accept="application/pdf,.pdf" hidden onchange={onFileInputChange} />
  {#if dragActive}<div class="zone-drag-label" aria-hidden="true">{t("pdf_drop_active")}</div>{/if}
</div>

<style>
  .zone {
    position: relative; border: 1.5px dashed var(--muted); border-radius: 4px;
    background: var(--card); padding: 20px 24px 24px; text-align: center;
    transition: background-color .15s, border-color .15s;
  }
  .zone.drag { background: var(--panel); border-color: var(--ink); border-style: solid; }
  .zone-hint { margin-top: 16px; font-size: 14px; color: var(--muted); }
  .linkish {
    border: 0; background: none; padding: 0; margin-left: 4px; font: inherit; font-size: 14px;
    color: var(--text); text-decoration: underline; cursor: pointer;
  }
  .linkish:hover { color: #555; }
  .zone-drag-label {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 700; color: var(--ink); background: rgba(244, 241, 234, .85);
    pointer-events: none; border-radius: 4px;
  }
</style>
