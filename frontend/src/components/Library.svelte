<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import { openLoginDialog } from "../lib/authDialogs.svelte";
  import { devicesStore } from "../lib/devices.svelte";
  import { t } from "../lib/i18n.svelte";
  import { libraryStore } from "../lib/library.svelte";
  import LibraryItem from "./LibraryItem.svelte";
  import RowMenu, { type RowMenuItem } from "./RowMenu.svelte";

  $effect(() => {
    if (authStore.account && libraryStore.loadState === "idle") {
      void libraryStore.load();
    }
  });

  // 「端末に追加」（一括バー・各行メニュー）の対象端末一覧のため、端末も読み込む。
  $effect(() => {
    if (authStore.account && devicesStore.loadState === "idle") {
      void devicesStore.load();
    }
  });

  // 選択状態（itemId の集合）。items との積集合を導出して使うことで、
  // 単体削除・リロード・アカウント切替で消えたアイテムの選択が自然に外れる。
  let selected = $state<Set<string>>(new Set());
  const selectedIds = $derived(libraryStore.items.filter((i) => selected.has(i.id)).map((i) => i.id));

  let bulkDeleting = $state(false);
  let bulkDownloading = $state(false);
  let bulkAdding = $state(false);
  let bulkFailedCount = $state(0);
  let bulkAddNote = $state<"" | "ok" | "fail">("");
  const bulkBusy = $derived(bulkDeleting || bulkDownloading || bulkAdding);

  function toggleSelect(itemId: string): void {
    const next = new Set(selected);
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    selected = next;
    bulkFailedCount = 0;
    bulkAddNote = "";
  }

  async function deleteSelected(): Promise<void> {
    const ids = selectedIds;
    if (ids.length === 0 || bulkBusy) return;
    if (!confirm(t("library_delete_selected_confirm")(ids.length))) return;
    bulkDeleting = true;
    bulkFailedCount = 0;
    bulkAddNote = "";
    // 成功した分は libraryStore.deleteItem が items から除去する。
    // 失敗した分は items に残り、selectedIds（積集合）にも残るため再試行できる。
    const results = await Promise.all(ids.map(async (id) => ({ id, ok: await libraryStore.deleteItem(id) })));
    const succeeded = results.filter((r) => r.ok);
    if (succeeded.length > 0) {
      const next = new Set(selected);
      for (const r of succeeded) next.delete(r.id);
      selected = next;
    }
    bulkFailedCount = results.length - succeeded.length;
    bulkDeleting = false;
  }

  // 選択アイテムを順次ダウンロード。既存の単体ダウンロードと同じ
  // /api/library/items/:id/download への a 要素 click を数百 ms 間隔で発火する。
  async function downloadSelected(): Promise<void> {
    const ids = selectedIds;
    if (ids.length === 0 || bulkBusy) return;
    bulkDownloading = true;
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 400));
      const a = document.createElement("a");
      a.href = `/api/library/items/${encodeURIComponent(ids[i])}/download`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    bulkDownloading = false;
  }

  // 選択アイテムを対象端末の配信リスト末尾へ追加（既載分はスキップ、冪等）。
  async function addSelectedToDevice(deviceId: string): Promise<void> {
    const ids = selectedIds;
    if (ids.length === 0 || bulkBusy) return;
    bulkAdding = true;
    bulkAddNote = "";
    const ok = await devicesStore.addItemsToDevice(deviceId, ids);
    bulkAddNote = ok ? "ok" : "fail";
    bulkAdding = false;
  }

  const activeDevices = $derived(devicesStore.devices.filter((d) => d.status !== "revoked"));

  const bulkDeviceMenuItems = $derived.by<RowMenuItem[]>(() => {
    if (activeDevices.length === 0) {
      return [{ label: t("library_add_to_device_none"), disabled: true }];
    }
    return activeDevices.map((d) => ({
      label: d.name,
      disabled: bulkBusy,
      onSelect: () => void addSelectedToDevice(d.id),
    }));
  });
</script>

<section class="library">
  {#if !authStore.account}
    <div class="login-gate">
      <p class="note">{t("account_login_prompt")}</p>
      <button type="button" class="secondary" onclick={openLoginDialog}>{t("account_login")}</button>
    </div>
  {:else if libraryStore.loadState === "loading" || libraryStore.loadState === "idle"}
    <p class="note">{t("library_loading")}</p>
  {:else if libraryStore.loadState === "fail"}
    <p class="error-text">{t("library_load_failed")}</p>
  {:else if libraryStore.items.length === 0}
    <p class="note">{t("library_empty")}</p>
  {:else}
    {#if selectedIds.length > 0}
      <div class="bulk-bar">
        <span class="bulk-count">{t("library_selected_count")(selectedIds.length)}</span>
        <button type="button" class="bulk-btn" disabled={bulkBusy} onclick={() => void downloadSelected()}>
          {t("library_download")}
        </button>
        <RowMenu label={t("library_add_to_device")} disabled={bulkBusy} items={bulkDeviceMenuItems} />
        <button type="button" class="bulk-btn danger" disabled={bulkBusy} onclick={() => void deleteSelected()}>
          {bulkDeleting ? t("library_deleting") : t("library_delete")}
        </button>
        {#if bulkFailedCount > 0}
          <p class="error-text bulk-note">{t("library_delete_selected_failed")(bulkFailedCount)}</p>
        {/if}
        {#if bulkAddNote === "ok"}
          <p class="note bulk-note">{t("library_add_to_device_done")}</p>
        {:else if bulkAddNote === "fail"}
          <p class="error-text bulk-note">{t("library_add_to_device_failed")}</p>
        {/if}
      </div>
    {/if}
    <ul class="items">
      {#each libraryStore.items as item (item.id)}
        <li>
          <LibraryItem
            {item}
            selected={selected.has(item.id)}
            selectDisabled={bulkBusy}
            onToggleSelect={() => toggleSelect(item.id)}
          />
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  section.library { padding: 0 0 24px; }
  .login-gate { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
  .note { color: var(--muted); font-size: 14px; }
  .bulk-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .bulk-bar .bulk-count { font-size: 14px; color: var(--muted2); margin-right: 4px; }
  /* ConvertForm.svelte の button.secondary（「青空文庫から選択」）と同じ見た目 */
  .bulk-bar .bulk-btn {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  .bulk-bar .bulk-btn:hover:not(:disabled) { background: var(--panel); }
  .bulk-bar .bulk-btn:disabled { border-color: var(--disabled); color: var(--disabled); cursor: default; }
  .bulk-bar .bulk-btn.danger { border-color: var(--error); color: var(--error); }
  .bulk-bar .bulk-btn.danger:disabled { border-color: var(--disabled); color: var(--disabled); }
  .bulk-bar .bulk-note { margin-top: 0; }
  ul.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  ul.items li + li { border-top: 1px solid var(--line); }
  ul.items li:last-child { border-bottom: 1px solid var(--line); }
  button.secondary {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  button.secondary:hover { background: var(--panel); }
</style>
