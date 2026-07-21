<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { devicesStore } from "../lib/devices.svelte";
  import { formatDate } from "../lib/jobs.svelte";
  import { t } from "../lib/i18n.svelte";
  import { formatSize, libraryStore, type LibraryItem } from "../lib/library.svelte";
  import RowMenu, { type RowMenuItem } from "./RowMenu.svelte";

  interface Props {
    item: LibraryItem;
    selected: boolean;
    selectDisabled: boolean;
    onToggleSelect: () => void;
  }
  const { item, selected, selectDisabled, onToggleSelect }: Props = $props();

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

  // 端末に追加: 対象端末の配信リスト末尾へ追加（既載ならスキップして成功扱い）。
  // フィードバックは Devices.svelte の「コピーしました」と同様、次の操作まで表示し続ける。
  let addingToDevice = $state(false);
  let addNote = $state<"" | "ok" | "fail">("");

  async function addToDevice(deviceId: string): Promise<void> {
    if (addingToDevice) return;
    addingToDevice = true;
    addNote = "";
    const ok = await devicesStore.addItemsToDevice(deviceId, [item.id]);
    addNote = ok ? "ok" : "fail";
    addingToDevice = false;
  }

  const activeDevices = $derived(devicesStore.devices.filter((d) => d.status !== "revoked"));

  const menuItems = $derived.by<RowMenuItem[]>(() => {
    const out: RowMenuItem[] = [
      { label: t("library_download"), href: `/api/library/items/${encodeURIComponent(item.id)}/download` },
      { label: t("library_item_edit"), onSelect: startEdit },
    ];
    if (activeDevices.length === 0) {
      out.push({ label: t("library_add_to_device_none"), disabled: true });
    } else {
      out.push({ label: t("library_add_to_device"), heading: true });
      for (const d of activeDevices) {
        out.push({ label: d.name, indent: true, disabled: addingToDevice, onSelect: () => void addToDevice(d.id) });
      }
    }
    out.push({ label: t("library_delete"), danger: true, disabled: deleting, onSelect: () => void onDelete() });
    return out;
  });

  // 行クリックで選択トグル（補助操作）。チェックボックス・⋮・popover 内・リンク等の
  // インタラクティブ要素からのバブリングでは発火させない。label を含めるのは、
  // チェックボックスの label 経由クリック（onchange で既にトグル済み）との二重発火を防ぐため。
  function onRowClick(event: MouseEvent): void {
    if (editing || selectDisabled) return;
    const target = event.target as Element | null;
    if (target?.closest("a, button, input, label, [popover]")) return;
    onToggleSelect();
  }
</script>

<!-- 行クリックは補助操作で、キーボード操作は行内のチェックボックスが担う -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="library-item" class:editing onclick={onRowClick}>
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
    <label class="select">
      <input
        type="checkbox"
        checked={selected}
        disabled={selectDisabled}
        aria-label={t("library_select_item")(item.title)}
        onchange={onToggleSelect}
      />
    </label>
    <div class="info">
      <div class="title">{item.title}</div>
      <div class="meta">
        {#if item.author}<span>{item.author}</span>{/if}
        <span>{formatSize(item.sizeBytes)}</span>
        <span>{formatDate(item.createdAt)}</span>
        {#if addNote === "ok"}
          <span class="add-note">{t("library_add_to_device_done")}</span>
        {:else if addNote === "fail"}
          <span class="add-note fail">{t("library_add_to_device_failed")}</span>
        {/if}
      </div>
    </div>
    <RowMenu items={menuItems} />
  {/if}
</div>

<style>
  .library-item { display: flex; align-items: center; gap: 14px; padding: 14px 0; }
  .library-item:not(.editing) { cursor: pointer; }
  .library-item.editing { flex-direction: column; align-items: stretch; gap: 8px; }
  /* タップターゲット確保: label の padding で当たり判定を広げつつ、行の高さは margin で相殺 */
  .select { display: flex; align-items: center; padding: 12px; margin: -12px -6px -12px -12px; cursor: pointer; }
  .select input { width: 18px; height: 18px; margin: 0; accent-color: var(--ink); cursor: pointer; }
  .select input:disabled { cursor: default; }
  .info { flex: 1; min-width: 0; }
  .info .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .info .meta { display: flex; gap: 10px; flex-wrap: wrap; font-family: var(--mono); font-size: 14px; color: var(--faint); margin-top: 4px; }
  .info .meta .add-note { font-family: inherit; color: var(--muted2); }
  .info .meta .add-note.fail { color: var(--error); }
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
