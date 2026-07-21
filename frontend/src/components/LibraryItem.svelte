<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { formatDate } from "../lib/jobs.svelte";
  import { t } from "../lib/i18n.svelte";
  import { formatSize, libraryStore, type LibraryItem } from "../lib/library.svelte";
  import RowMenu from "./RowMenu.svelte";

  interface Props {
    item: LibraryItem;
  }
  const { item }: Props = $props();

  let editing = $state(false);
  // 編集開始時に startEdit() で必ず上書きするため、ここでの初期値は
  // 「まだ編集を開始していない」間だけ使う一度きりの初期値でよい。
  // svelte-ignore state_referenced_locally
  let titleInput = $state(item.title);
  // svelte-ignore state_referenced_locally
  let authorInput = $state(item.author ?? "");
  let busy = $state(false);
  let deleting = $state(false);

  function startEdit(): void {
    titleInput = item.title;
    authorInput = item.author ?? "";
    editing = true;
  }

  async function saveEdit(): Promise<void> {
    const title = titleInput.trim();
    if (!title) return;
    busy = true;
    const ok = await libraryStore.updateItem(item.id, { title, author: authorInput.trim() || null });
    busy = false;
    if (ok) editing = false;
  }

  async function onDelete(): Promise<void> {
    if (!confirm(t("library_delete_confirm"))) return;
    deleting = true;
    await libraryStore.deleteItem(item.id);
  }
</script>

<div class="library-item" class:editing>
  {#if editing}
    <div class="edit-fields">
      <input type="text" bind:value={titleInput} maxlength="200" />
      <input type="text" bind:value={authorInput} maxlength="200" placeholder={t("library_author_none")} />
    </div>
    <div class="row-actions">
      <button type="button" class="text-btn" disabled={busy} onclick={() => (editing = false)}>{t("cancel")}</button>
      <button type="button" class="text-btn primary" disabled={busy || !titleInput.trim()} onclick={() => void saveEdit()}>{t("save")}</button>
    </div>
  {:else}
    <div class="info">
      <div class="title">{item.title}</div>
      <div class="meta">
        {#if item.author}<span>{item.author}</span>{/if}
        <span>{formatSize(item.sizeBytes)}</span>
        <span>{formatDate(item.createdAt)}</span>
      </div>
    </div>
    <RowMenu
      items={[
        { label: t("library_download"), href: `/api/library/items/${encodeURIComponent(item.id)}/download` },
        { label: t("library_item_edit"), onSelect: startEdit },
        { label: t("library_delete"), danger: true, disabled: deleting, onSelect: () => void onDelete() },
      ]}
    />
  {/if}
</div>

<style>
  .library-item { display: flex; align-items: center; gap: 14px; padding: 14px 0; }
  .library-item.editing { flex-direction: column; align-items: stretch; gap: 8px; }
  .info { flex: 1; min-width: 0; }
  .info .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .info .meta { display: flex; gap: 10px; flex-wrap: wrap; font-family: var(--mono); font-size: 14px; color: var(--faint); margin-top: 4px; }
  .edit-fields { display: flex; flex-direction: column; gap: 6px; }
  .edit-fields input {
    padding: 8px 10px; font: inherit; font-size: 14px; border: 1.5px solid var(--ink);
    border-radius: 4px; background: var(--card); color: var(--text);
  }
  .row-actions { display: flex; gap: 14px; flex-wrap: wrap; }
  .text-btn {
    border: 0; background: none; font: inherit; font-size: 14px; color: var(--muted2);
    text-decoration: underline; cursor: pointer; padding: 0;
  }
  .text-btn.primary { color: var(--ink); font-weight: 700; }
  .text-btn:disabled { opacity: .5; cursor: default; }
</style>
