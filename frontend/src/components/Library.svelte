<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import { openLoginDialog } from "../lib/authDialogs.svelte";
  import { t } from "../lib/i18n.svelte";
  import { libraryStore } from "../lib/library.svelte";
  import LibraryItem from "./LibraryItem.svelte";

  $effect(() => {
    if (authStore.account && libraryStore.loadState === "idle") {
      void libraryStore.load();
    }
  });

  // 選択状態（itemId の集合）。items との積集合を導出して使うことで、
  // 単体削除・リロード・アカウント切替で消えたアイテムの選択が自然に外れる。
  let selected = $state<Set<string>>(new Set());
  const selectedIds = $derived(libraryStore.items.filter((i) => selected.has(i.id)).map((i) => i.id));

  let bulkDeleting = $state(false);
  let bulkFailedCount = $state(0);

  function toggleSelect(itemId: string): void {
    const next = new Set(selected);
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    selected = next;
    bulkFailedCount = 0;
  }

  async function deleteSelected(): Promise<void> {
    const ids = selectedIds;
    if (ids.length === 0 || bulkDeleting) return;
    if (!confirm(t("library_delete_selected_confirm")(ids.length))) return;
    bulkDeleting = true;
    bulkFailedCount = 0;
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
        <button type="button" class="bulk-delete" disabled={bulkDeleting} onclick={() => void deleteSelected()}>
          {bulkDeleting ? t("library_deleting") : t("library_delete_selected")(selectedIds.length)}
        </button>
        {#if bulkFailedCount > 0}
          <p class="error-text bulk-error">{t("library_delete_selected_failed")(bulkFailedCount)}</p>
        {/if}
      </div>
    {/if}
    <ul class="items">
      {#each libraryStore.items as item (item.id)}
        <li>
          <LibraryItem
            {item}
            selected={selected.has(item.id)}
            selectDisabled={bulkDeleting}
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
  .bulk-bar { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 6px; }
  .bulk-bar .bulk-delete {
    border: 0; background: none; color: var(--error); font: inherit; font-size: 14px;
    cursor: pointer; text-decoration: underline; padding: 12px 4px; margin: -12px -4px;
  }
  .bulk-bar .bulk-delete:disabled { color: var(--disabled); cursor: default; }
  .bulk-bar .bulk-error { margin-top: 0; }
  ul.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  ul.items li + li { border-top: 1px solid var(--line); }
  ul.items li:last-child { border-bottom: 1px solid var(--line); }
  button.secondary {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  button.secondary:hover { background: var(--panel); }
</style>
