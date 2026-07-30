<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // 汎用OPDSカタログダイアログ（仕様書 §8.4）。コンポーネント自体は汎用だが、
  // 初期リリースではMemlane専用ラベルで開く（仕様書 §28）。
  // 2ステップ構成: ステップ1「選択」→ステップ2「変換オプション」。ステップ状態
  // (opdsStore.catalogStep) は store 側で持つ（ダイアログ開閉状態など、既存の
  // カタログダイアログ関連 state と同じ置き場所に揃えている）。
  import { registerCreatedJob } from "../lib/convert.svelte";
  import { DEFAULT_EPUB_OPTIONS, defaultEpubFontForLang, isValidEpubOptions, type EpubConvertOptions } from "../lib/epub-options";
  import { getLang, t } from "../lib/i18n.svelte";
  import { opdsStore } from "../lib/opds.svelte";
  import { OPDS_SELECTION_MAX, type OpdsPublicationEntry } from "../lib/opds-entry";
  import { targetDeviceStore } from "../lib/targetDevice.svelte";
  import EpubOptions from "./EpubOptions.svelte";
  import OpdsEntryRow from "./OpdsEntryRow.svelte";

  let dlg = $state<HTMLDialogElement | null>(null);
  let searchText = $state("");
  // font（UI言語ごとの既定値）はEpubInputPanel.svelteと同じ扱い: マウント時に
  // 一度だけ getLang() を読む。このダイアログはApp.svelteで常時マウントされる
  // シングルトンのため、deviceのように開くたびに追従はさせない（フォームを
  // 開いてからUI言語を切り替えても、次にダイアログを開き直すまでは既存の
  // 選択のまま — 他のフォーム項目と同じ扱い）。
  let epubOptions = $state<EpubConvertOptions>({
    ...DEFAULT_EPUB_OPTIONS,
    font: defaultEpubFontForLang(getLang()),
    device: targetDeviceStore.device,
  });

  // このダイアログは App.svelte で常時マウントされるシングルトンのため、
  // モジュール初期化時（アプリ起動時）の $state 初期値だけでは device が
  // トグル変更に追従しない（ManualOpdsDeviceDialog.svelte と違い、コンポーネント
  // 自体は毎回作り直されない）。開くたびに ConvertForm.svelte 上部のトグルの
  // 現在値を反映する。
  $effect(() => {
    if (!dlg) return;
    if (opdsStore.catalogDialogOpen) {
      if (!dlg.open) {
        epubOptions = { ...epubOptions, device: targetDeviceStore.device };
        dlg.showModal();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  });

  function close(): void {
    opdsStore.closeCatalogDialog();
  }

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) close(); // ::backdrop 領域のクリック
  }

  const errorText = $derived.by(() => {
    const key = opdsStore.catalogErrorKey;
    return key ? t(key) : null;
  });

  const optionsValid = $derived(isValidEpubOptions(epubOptions));
  const canGoToOptions = $derived(opdsStore.selectedCount > 0 && !opdsStore.importBusy);
  const canImport = $derived(
    opdsStore.selectedCount > 0 && optionsValid && !opdsStore.importBusy,
  );

  function onSearchSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void opdsStore.search(searchText);
  }

  function onToggle(entry: OpdsPublicationEntry, checked: boolean): void {
    opdsStore.toggle(entry, checked);
  }

  async function onNavigate(cursor: string): Promise<void> {
    searchText = "";
    await opdsStore.goToNavigationEntry(cursor);
  }

  function onNext(): void {
    if (!canGoToOptions) return;
    opdsStore.goToOptionsStep();
  }

  function onBack(): void {
    opdsStore.backToSelectStep();
  }

  async function onImport(): Promise<void> {
    if (!canImport) return;
    await opdsStore.startImport(epubOptions, registerCreatedJob);
    // 成否にかかわらず常にダイアログを閉じ、裏で動いている既存のジョブ UI で
    // 各ジョブのステータスを見せる（青空文庫ダイアログと同じ流儀）。開始に
    // 失敗した件数はジョブが作られず既存のジョブ UI に現れないため、
    // ConvertForm 側で importSummary.failedCount を読んで表示する。
    opdsStore.closeCatalogDialog();
  }

  // Library.svelte の削除確認と同じ流儀（native confirm）。
  async function onDisconnect(): Promise<void> {
    if (!confirm(t("memlane_disconnect_confirm"))) return;
    await opdsStore.disconnect();
  }

  function onReplaceConnection(): void {
    opdsStore.closeCatalogDialog();
    opdsStore.openConnectDialog();
  }
</script>

<dialog
  class="catalog-dialog"
  bind:this={dlg}
  aria-labelledby="opds-catalog-title"
  onclick={onDialogClick}
  onclose={close}
>
  <div class="dlg-head">
    <div class="dlg-head-titles">
      <span class="dlg-title" id="opds-catalog-title">{t("memlane_catalog_title")}</span>
      {#if opdsStore.catalogPage}<span class="dlg-subtitle">{opdsStore.catalogPage.title}</span>{/if}
    </div>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={close}>×</button>
  </div>

  {#if opdsStore.catalogStep === "select"}
    <div class="dlg-toolbar">
      {#if opdsStore.canGoBack}
        <button type="button" class="toolbar-btn" onclick={() => void opdsStore.goBack()}>← {t("memlane_back")}</button>
      {/if}
      {#if opdsStore.catalogPage?.searchSupported}
        <form class="search-form" onsubmit={onSearchSubmit}>
          <input
            bind:value={searchText}
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder={t("memlane_search_placeholder")}
            aria-label={t("memlane_search_placeholder")}
          />
        </form>
      {/if}
    </div>

    <div class="dlg-list-head">
      <span>{opdsStore.selectedCount > 0 || opdsStore.catalogPage ? t("memlane_selected_count")(opdsStore.selectedCount, OPDS_SELECTION_MAX) : ""}</span>
    </div>

    {#if opdsStore.catalogLoading}
      <div class="dlg-list dlg-list-status"><div class="dlg-status">{t("memlane_catalog_loading")}</div></div>
    {:else if errorText}
      <div class="dlg-list dlg-list-status">
        <div class="dlg-status error-text">{t("memlane_catalog_failed")}<br />{errorText}</div>
      </div>
    {:else if opdsStore.catalogPage && opdsStore.catalogPage.entries.length === 0}
      <div class="dlg-list dlg-list-status"><div class="dlg-status">{t("memlane_catalog_empty")}</div></div>
    {:else if opdsStore.catalogPage}
      <ul class="dlg-list">
        {#each opdsStore.catalogPage.entries as entry (entry.id)}
          <OpdsEntryRow
            {entry}
            selected={entry.kind === "publication" && opdsStore.isSelected(entry.id)}
            selectionDisabled={opdsStore.selectedCount >= OPDS_SELECTION_MAX}
            onToggle={(checked) => entry.kind === "publication" && onToggle(entry, checked)}
            onNavigate={(cursor) => void onNavigate(cursor)}
          />
        {/each}
      </ul>
    {/if}

    <div class="dlg-pagination">
      {#if opdsStore.catalogPage?.previousCursor}
        <button type="button" class="dlg-cancel" onclick={() => void opdsStore.goPrevious()}>← {t("memlane_previous")}</button>
      {/if}
      {#if opdsStore.catalogPage?.nextCursor}
        <button type="button" class="dlg-cancel" onclick={() => void opdsStore.goNext()}>{t("memlane_next")} →</button>
      {/if}
    </div>
  {:else}
    <div class="dlg-list-head">
      <span>{t("memlane_selected_count")(opdsStore.selectedCount, OPDS_SELECTION_MAX)}</span>
    </div>
    <div class="dlg-list">
      <ul class="dlg-summary-list">
        {#each [...opdsStore.selected.values()] as entry (entry.id)}
          <li class="dlg-summary-item">{entry.title}</li>
        {/each}
      </ul>

      <div class="dlg-options">
        <EpubOptions bind:options={epubOptions} />
      </div>
    </div>
  {/if}

  <div class="dlg-actions" class:dlg-actions-solo={opdsStore.catalogStep !== "select"}>
    {#if opdsStore.catalogStep === "select"}
      <div class="dlg-actions-left">
        <button type="button" class="dlg-cancel" onclick={onReplaceConnection}>{t("memlane_replace_connection")}</button>
        <button type="button" class="dlg-cancel dlg-disconnect" disabled={opdsStore.disconnectBusy} onclick={() => void onDisconnect()}>{t("memlane_disconnect")}</button>
      </div>
      <div class="dlg-actions-right">
        <button type="button" class="dlg-outline" onclick={close}>{t("cancel")}</button>
        <button type="button" class="dlg-convert" disabled={!canGoToOptions} onclick={onNext}>{t("memlane_to_options")}</button>
      </div>
    {:else}
      <div class="dlg-actions-right">
        <button type="button" class="dlg-outline" onclick={onBack}>{t("memlane_back_to_selection")}</button>
        <button type="button" class="dlg-convert" disabled={!canImport} onclick={() => void onImport()}>
          {opdsStore.importBusy ? t("memlane_importing") : t("memlane_import")(opdsStore.selectedCount)}
        </button>
      </div>
    {/if}
  </div>
</dialog>

<style>
  dialog.catalog-dialog {
    padding: 0; border: 1.5px solid var(--ink); border-radius: 4px;
    background: var(--bg); color: var(--text);
    width: min(560px, calc(100vw - 32px));
    height: min(640px, calc(100vh - 96px));
    height: min(640px, calc(100dvh - 96px));
    box-shadow: 4px 4px 0 rgba(var(--ink-rgb), .35);
  }
  dialog.catalog-dialog[open] { display: flex; flex-direction: column; }
  @media (max-width: 600px) {
    dialog.catalog-dialog[open] {
      height: calc(100vh - 96px);
      height: calc(100dvh - 96px);
    }
  }
  dialog.catalog-dialog::backdrop { background: rgba(var(--ink-rgb), .45); }
  .dlg-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    padding: 16px 22px; border-bottom: 1px solid var(--line); flex: none;
  }
  .dlg-head-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .dlg-title { font-size: 16px; font-weight: 700; letter-spacing: .04em; }
  .dlg-subtitle { font-family: var(--mono); font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dlg-x {
    width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--line-strong); border-radius: 4px; background: none; color: var(--muted);
    font-size: 14px; line-height: 1; cursor: pointer; font-family: inherit; flex: none;
  }
  .dlg-x:hover { color: var(--text); }
  .dlg-toolbar { display: flex; align-items: center; gap: 12px; padding: 14px 22px 4px; flex: none; flex-wrap: wrap; min-height: 58px; }
  .toolbar-btn {
    padding: 6px 12px; font: inherit; font-size: 13px; border: 1px solid var(--line); border-radius: 4px;
    background: var(--card); color: var(--text); cursor: pointer;
  }
  .search-form { flex: 1; min-width: 160px; }
  .search-form input {
    width: 100%; padding: 9px 12px; font: inherit; font-size: 14px; border: 1px solid var(--line);
    border-radius: 4px; background: var(--card); color: var(--text);
  }
  .dlg-list-head {
    padding: 8px 22px 4px; font-family: var(--mono); font-size: 12px; color: var(--muted);
    letter-spacing: .12em; flex: none;
  }
  .dlg-list { list-style: none; margin: 0; padding: 0 22px; overflow-y: auto; flex: 1; min-height: 100px; }
  .dlg-list-status { display: block; }
  .dlg-status { padding: 16px 2px; font-size: 14px; color: var(--muted); }
  .dlg-summary-list { list-style: none; margin: 0; padding: 0; }
  .dlg-summary-item { padding: 10px 2px; font-size: 14px; border-bottom: 1px solid var(--line); }
  .dlg-summary-item:last-child { border-bottom: none; }
  .dlg-pagination { display: flex; justify-content: space-between; padding: 8px 22px; flex: none; min-height: 38px; }
  .dlg-options { padding: 8px 0 0; flex: none; }
  .error-text { color: var(--error); }
  .dlg-actions {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    padding: 14px 22px 18px; flex: none;
  }
  .dlg-actions-solo { justify-content: flex-end; }
  .dlg-actions-left, .dlg-actions-right { display: flex; align-items: center; gap: 16px; }
  .dlg-cancel {
    border: 0; background: none; font: inherit; font-size: 14px; color: var(--muted);
    text-decoration: underline; cursor: pointer; padding: 0;
  }
  .dlg-disconnect:disabled { opacity: .5; cursor: default; }
  .dlg-outline {
    padding: 9px 23px; font: inherit; font-size: 14px; font-weight: 700; letter-spacing: .08em;
    border: 1px solid var(--ink); border-radius: 4px; background: var(--card); color: var(--ink);
    cursor: pointer; white-space: nowrap;
  }
  .dlg-outline:hover { background: var(--panel); }
  .dlg-outline:disabled { opacity: .55; cursor: default; }
  .dlg-convert {
    padding: 10px 24px; font: inherit; font-size: 14px; font-weight: 700; letter-spacing: .08em;
    border: 0; border-radius: 4px; background: var(--ink); color: var(--ink-text); cursor: pointer;
    white-space: nowrap;
  }
  .dlg-convert:disabled { opacity: .55; cursor: default; }
</style>
