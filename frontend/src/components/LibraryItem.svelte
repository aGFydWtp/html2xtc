<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { formatDate } from "../lib/jobs.svelte";
  import { t } from "../lib/i18n.svelte";
  import { formatSize, libraryStore, type LibraryItem } from "../lib/library.svelte";

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

<div class="library-item">
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
    <div class="row-actions">
      <a class="text-btn" href="/api/library/items/{encodeURIComponent(item.id)}/download">{t("library_download")}</a>
      <button type="button" class="text-btn" onclick={startEdit}>{t("library_item_edit")}</button>
      <button type="button" class="text-btn danger" disabled={deleting} onclick={() => void onDelete()}>{t("library_delete")}</button>
    </div>
  {/if}
</div>

<style>
  .library-item { display: flex; flex-direction: column; gap: 8px; padding: 14px 0; }
  .info .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .info .meta { display: flex; gap: 10px; flex-wrap: wrap; font-family: var(--mono); font-size: 12px; color: var(--faint); margin-top: 4px; }
  .edit-fields { display: flex; flex-direction: column; gap: 6px; }
  .edit-fields input {
    padding: 8px 10px; font: inherit; font-size: 14px; border: 1.5px solid var(--ink);
    border-radius: 4px; background: var(--card); color: var(--text);
  }
  .row-actions { display: flex; gap: 14px; flex-wrap: wrap; }
  .text-btn {
    border: 0; background: none; font: inherit; font-size: 13px; color: var(--muted2);
    text-decoration: underline; cursor: pointer; padding: 0;
  }
  .text-btn.primary { color: var(--ink); font-weight: 700; }
  .text-btn.danger { color: var(--error); }
  .text-btn:disabled { opacity: .5; cursor: default; }
</style>
