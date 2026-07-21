<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { AOZORA_MAX, aozora, type AozoraBook } from "../lib/aozora.svelte";
  import { submitUrl } from "../lib/convert.svelte";
  import { t } from "../lib/i18n.svelte";

  let dlg = $state<HTMLDialogElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);

  // open 状態とネイティブ <dialog> の開閉を同期する。開いた直後に検索ボックスへ
  // フォーカスする。閉じるは onclose → aozora.hide() で状態側へ反映する。
  $effect(() => {
    if (!dlg) return;
    if (aozora.open) {
      if (!dlg.open) {
        dlg.showModal();
        input?.focus();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  });

  // 一覧の作品名。副題があればタイトルに併記する。
  function bookTitle(b: AozoraBook): string {
    return b.subtitle ? `${b.title} ${b.subtitle}` : b.title;
  }
  // ジョブの表示タイトル「タイトル — 作者」。
  function jobTitle(b: AozoraBook): string {
    return [bookTitle(b), b.author].filter(Boolean).join(" — ");
  }

  const statusText = $derived.by(() => {
    switch (aozora.listState) {
      case "searching": return t("aozora_searching");
      case "empty": return t("aozora_empty");
      case "fail": return t("aozora_fail");
      default: return t("aozora_start");
    }
  });

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) aozora.hide(); // ::backdrop 領域のクリック
  }

  // 選択作品を htmlUrl で 1 件ずつ順に投入し、ダイアログを閉じる。main 側は
  // 複数ジョブの並行ポーリングに対応済みなので、全件が変換中表示に載る。
  async function onConvert(): Promise<void> {
    const books = [...aozora.selected.values()];
    if (!books.length) return;
    aozora.hide();
    for (const b of books) {
      await submitUrl(b.htmlUrl, false, jobTitle(b));
    }
  }
</script>

<dialog
  class="aozora-dialog"
  bind:this={dlg}
  aria-labelledby="aozora-dialog-title"
  onclick={onDialogClick}
  onclose={() => aozora.hide()}
>
  <div class="dlg-head">
    <span class="dlg-title" id="aozora-dialog-title">{t("aozora_title")}</span>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={() => aozora.hide()}>×</button>
  </div>

  <div class="dlg-search">
    <div class="dlg-search-row">
      <span class="dlg-search-icon" aria-hidden="true">⌕</span>
      <!-- svelte-ignore a11y_autofocus 開いた直後の $effect でフォーカスするため autofocus は使わない -->
      <input
        class="dlg-q"
        type="search"
        autocomplete="off"
        spellcheck="false"
        bind:this={input}
        value={aozora.query}
        oninput={(e) => aozora.onInput(e.currentTarget.value)}
      />
    </div>
    <div class="dlg-hint">{t("aozora_hint")}</div>
  </div>

  <div class="dlg-list-head">
    <span>{aozora.listState === "results" ? t("aozora_results")(aozora.results.length) : ""}</span>
    <span>{t("aozora_selected")(aozora.selectedCount, AOZORA_MAX)}</span>
  </div>

  {#if aozora.listState === "results"}
    <ul class="dlg-list">
      {#each aozora.results as b (b.workId)}
        {@const on = aozora.isSelected(b.workId)}
        {@const full = !on && aozora.selectedCount >= AOZORA_MAX}
        <li class:on>
          <label>
            <input
              type="checkbox"
              checked={on}
              disabled={full}
              onchange={(e) => aozora.toggle(b, e.currentTarget.checked)}
            />
            <div class="dlg-book">
              <div class="dlg-book-title">{bookTitle(b)}</div>
              <div class="dlg-book-author">{b.author}</div>
            </div>
          </label>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="dlg-list dlg-list-status"><div class="dlg-status">{statusText}</div></div>
  {/if}

  <div class="dlg-actions">
    <div class="dlg-actions-right">
      <button type="button" class="dlg-cancel" onclick={() => aozora.hide()}>{t("cancel")}</button>
      <button
        type="button"
        class="dlg-convert"
        disabled={aozora.selectedCount === 0}
        onclick={() => void onConvert()}
      >{t("aozora_convert")(aozora.selectedCount)}</button>
    </div>
  </div>
</dialog>

<style>
  dialog.aozora-dialog {
    padding: 0; border: 1.5px solid var(--ink); border-radius: 4px;
    background: var(--bg); color: var(--text);
    width: min(480px, calc(100vw - 32px));
    max-height: calc(100vh - 96px);
    box-shadow: 4px 4px 0 rgba(28, 26, 23, .35);
  }
  dialog.aozora-dialog[open] { display: flex; flex-direction: column; }
  dialog.aozora-dialog::backdrop { background: rgba(28, 26, 23, .45); }
  .dlg-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 16px 22px; border-bottom: 1px solid var(--line); flex: none;
  }
  .dlg-title { font-size: 16px; font-weight: 700; letter-spacing: .04em; }
  .dlg-x {
    width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    border: 1px solid #cfc9bd; border-radius: 4px; background: none; color: var(--muted);
    font-size: 14px; line-height: 1; cursor: pointer; font-family: inherit;
  }
  .dlg-x:hover { color: var(--text); }
  .dlg-search { padding: 18px 22px 6px; flex: none; }
  .dlg-search-row {
    display: flex; align-items: center; gap: 10px; border: 1.5px solid var(--ink);
    border-radius: 4px; background: var(--card); padding: 11px 14px;
  }
  .dlg-search-row:focus-within { outline: 2px solid var(--ink); outline-offset: 1px; }
  .dlg-search-icon { flex: none; color: var(--muted); font-size: 15px; line-height: 1; }
  .dlg-q { flex: 1; min-width: 0; border: 0; background: none; font: inherit; font-size: 16px; color: var(--text); }
  .dlg-q:focus { outline: none; }
  .dlg-q::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
  .dlg-hint { margin-top: 8px; font-size: 12px; color: var(--muted); }
  .dlg-list-head {
    display: flex; align-items: baseline; justify-content: space-between;
    padding: 10px 22px 4px; font-family: var(--mono); font-size: 12px; color: var(--muted);
    letter-spacing: .12em; flex: none;
  }
  .dlg-list { list-style: none; margin: 0; padding: 0 22px; overflow-y: auto; flex: 1; min-height: 120px; }
  .dlg-list li { border-top: 1px solid var(--line); }
  .dlg-list li:last-child { border-bottom: 1px solid var(--line); }
  .dlg-list label { display: flex; align-items: center; gap: 12px; padding: 11px 2px; cursor: pointer; }
  .dlg-list li.on label { background: var(--panel); margin: 0 -22px; padding: 11px 22px; }
  .dlg-list input[type="checkbox"] {
    flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--ink); cursor: pointer;
  }
  .dlg-list input[type="checkbox"]:disabled { cursor: default; }
  .dlg-book { flex: 1; min-width: 0; }
  .dlg-book-title { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dlg-list li.on .dlg-book-title { font-weight: 700; }
  .dlg-book-author { font-family: var(--mono); font-size: 12px; color: var(--faint); }
  .dlg-list-status { display: block; }
  .dlg-status { padding: 16px 2px; font-size: 14px; color: var(--muted); }
  .dlg-actions {
    display: flex; align-items: center; justify-content: flex-end; gap: 12px;
    padding: 12px 22px 16px; flex: none;
  }
  .dlg-actions-right { display: flex; align-items: center; gap: 16px; }
  .dlg-cancel {
    border: 0; background: none; font: inherit; font-size: 14px; color: var(--muted);
    text-decoration: underline; cursor: pointer; padding: 0;
  }
  .dlg-convert {
    padding: 10px 24px; font: inherit; font-size: 14px; font-weight: 700; letter-spacing: .08em;
    border: 0; border-radius: 4px; background: var(--ink); color: var(--ink-text); cursor: pointer;
    white-space: nowrap;
  }
  .dlg-convert:disabled { opacity: .55; cursor: default; }
</style>
