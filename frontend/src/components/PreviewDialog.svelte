<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { tick } from "svelte";
  import { noteKey, noteText, t } from "../lib/i18n.svelte";
  import { closePreview, movePreview, openPreview, preview, previewCache, previewFail } from "../lib/preview.svelte";
  import { decodeFrame } from "../lib/xtc";

  let dlg = $state<HTMLDialogElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let prevBtn = $state<HTMLButtonElement | null>(null);
  let nextBtn = $state<HTMLButtonElement | null>(null);

  const s = $derived(preview.state);
  const noteState = $derived(s && "note" in s ? s : null);
  const loadingState = $derived(s && "loading" in s ? s : null);
  const pageState = $derived(s && "page" in s ? s : null);
  const cached = $derived(pageState ? previewCache.get(pageState.jobId) : undefined);

  // パース失敗と期限切れは再試行不能; 一時的な fetch エラーは再試行できる。
  const retryable = $derived(
    noteState !== null
      && noteKey(noteState.note) !== "preview_parse_fail"
      && noteKey(noteState.note) !== "preview_expired",
  );

  // 状態の有無とネイティブ <dialog> の開閉を同期する。
  $effect(() => {
    if (!dlg) return;
    if (preview.state) {
      if (!dlg.open) dlg.showModal();
    } else if (dlg.open) {
      dlg.close();
    }
  });

  // 表示ページのデコードと canvas への描画。表示するページだけをデコードする。
  $effect(() => {
    if (!pageState || !canvas) return;
    const entry = previewCache.get(pageState.jobId);
    if (!entry) return;
    try {
      const image = decodeFrame(entry.dv, entry.pages[pageState.page]);
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d")?.putImageData(image, 0, 0);
    } catch {
      previewFail(pageState.jobId, "preview_parse_fail");
    }
  });

  // ページ送りで押したボタンが disabled になるとフォーカスが body に落ちるため、
  // 対になるボタン（それも無効なら最初の有効なボタン）へ戻す。
  async function nav(delta: number): Promise<void> {
    movePreview(delta);
    await tick();
    const active = document.activeElement;
    if (dlg && active && dlg.contains(active) && !(active as HTMLButtonElement).disabled) return;
    const pair = delta > 0 ? [prevBtn, nextBtn] : [nextBtn, prevBtn];
    const target = pair.find((b) => b && !b.disabled) ?? dlg?.querySelector<HTMLButtonElement>("button:enabled");
    target?.focus();
  }

  // 状態の種類が切り替わってフォーカス対象が消えた場合（読み込み中 → ページ表示、
  // 再試行 → 読み込み中など）は、ダイアログ内の最初の有効なボタンへ戻す。
  $effect(() => {
    void s;
    const d = dlg;
    if (!d?.open) return;
    void tick().then(() => {
      if (!d.open) return;
      const active = document.activeElement;
      if (active && d.contains(active) && !(active as HTMLButtonElement).disabled) return;
      d.querySelector<HTMLButtonElement>("button:enabled")?.focus();
    });
  });

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) dlg?.close(); // ::backdrop 領域のクリック
  }
  function retry(): void {
    if (preview.state) void openPreview(preview.state.jobId);
  }
</script>

<dialog
  class="preview-dialog"
  bind:this={dlg}
  aria-labelledby="preview-dialog-title"
  onclick={onDialogClick}
  onclose={closePreview}
>
  <div class="pd-inner">
    <div class="pd-head">
      <span class="pd-title" id="preview-dialog-title">{t("preview")}</span>
      <button type="button" class="pd-x" aria-label={t("preview_close")} onclick={() => dlg?.close()}>✕</button>
    </div>
    {#if noteState}
      <div class="error-text">{noteText(noteState.note)}</div>
      {#if retryable}
        <div class="preview-bar"><button type="button" onclick={retry}>{t("preview_retry")}</button></div>
      {/if}
    {:else if loadingState}
      <div class="preview-loading">{t("preview_loading")}</div>
    {:else if pageState && cached}
      <div class="preview-bar">
        <button type="button" bind:this={prevBtn} disabled={pageState.page === 0} onclick={() => void nav(-1)}>{t("preview_prev")}</button>
        <span class="preview-page">{t("preview_page")(pageState.page + 1, cached.pages.length)}</span>
        <button type="button" bind:this={nextBtn} disabled={pageState.page === cached.pages.length - 1} onclick={() => void nav(1)}>{t("preview_next")}</button>
      </div>
      <canvas class="preview-canvas" bind:this={canvas}></canvas>
    {/if}
  </div>
</dialog>

<style>
  dialog.preview-dialog {
    padding: 0; border: 1.5px solid var(--ink); border-radius: 4px;
    background: var(--card); color: var(--text);
    width: min(560px, calc(100vw - 32px));
  }
  dialog.preview-dialog::backdrop { background: rgba(28, 26, 23, .5); }
  .pd-inner { padding: 14px 16px 16px; }
  .pd-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .pd-title { font-weight: 700; letter-spacing: .06em; }
  .pd-x {
    border: 0; background: none; font: inherit; font-size: 18px; line-height: 1;
    cursor: pointer; color: var(--muted2); padding: 8px; margin: -8px; border-radius: 4px;
  }
  .pd-x:hover { color: var(--text); }
  .preview-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .pd-inner .preview-bar { margin-top: 12px; }
  .preview-bar button {
    padding: 6px 14px; font: inherit; font-size: 14px; cursor: pointer;
    border: 1px solid var(--ink); border-radius: 4px; background: var(--card); color: var(--text);
  }
  .preview-bar button:disabled { border-color: var(--line); color: var(--disabled); cursor: default; }
  .preview-page { font-family: var(--mono); font-size: 14px; color: var(--muted2); }
  .preview-canvas {
    display: block; margin: 12px auto 0; max-width: 100%; max-height: calc(100vh - 220px);
    width: auto; height: auto; border: 1px solid var(--line); background: var(--card);
  }
  .preview-loading { font-family: var(--mono); font-size: 14px; color: var(--muted); margin-top: 10px; }
</style>
