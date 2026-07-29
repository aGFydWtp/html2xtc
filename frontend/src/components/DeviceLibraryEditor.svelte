<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from "svelte";
  import { devicesStore, type Device, type DeviceLibraryItem } from "../lib/devices.svelte";
  import { t } from "../lib/i18n.svelte";
  import { libraryStore } from "../lib/library.svelte";
  import { isResolutionMismatch } from "../lib/resolution-mismatch";

  interface Props {
    device: Device;
    onclose: () => void;
  }
  const { device, onclose }: Props = $props();

  interface ItemMeta {
    title: string;
    author: string | null;
    sizeBytes: number;
    // GET /api/devices/:id/library の DeviceLibraryItemDto には解像度が
    // 含まれない（src/devices/service.ts）ため、既に配信リストに載っている
    // 項目は /api/library/items 側（width/height 露出済み）を id で
    // 突き合わせて解決する。突き合わせに失敗した場合は null（警告は出さない）。
    width: number | null;
    height: number | null;
  }

  let dlg = $state<HTMLDialogElement | null>(null);
  let version = $state<number | null>(null);
  let assignedOrder = $state<string[]>([]);
  // 端末側から返ってきた「配信リストに載っている項目」の生データ（title/author/
  // sizeBytes のみ、DeviceLibraryItemDto に width/height は含まれない）。
  // assignedOrder はユーザー操作で並び替え/追加/削除される UI 状態なので、
  // それとは別にサーバー由来のメタだけをここに保持する。
  let deviceItems = $state<DeviceLibraryItem[]>([]);
  let loadState = $state<"loading" | "loaded" | "fail">("loading");
  let saving = $state(false);
  let conflict = $state(false);
  let saveFailed = $state(false);

  const unassigned = $derived(
    libraryStore.items.map((i) => i.id).filter((id) => !assignedOrder.includes(id)),
  );

  // LibraryItem.svelte の menuItems ($derived.by) と同じパターン: libraryStore.items
  // （/api/library/items、width/height 露出済み）を id で突き合わせて解決するため、
  // libraryStore.items が load() 完了後に更新されても自動的に追従する。以前は
  // plain な Map に一度きりで確定させていたため、load() 呼び出し時点で
  // libraryStore.items がまだ空/不完全（他画面の取得が in-flight）だと
  // width/height が null に固定されたまま更新されず、ミスマッチがあっても
  // バッジが出ないレースがあった。
  const itemMeta = $derived.by<Map<string, ItemMeta>>(() => {
    const libraryById = new Map(libraryStore.items.map((i) => [i.id, i]));
    const meta = new Map<string, ItemMeta>();
    for (const i of deviceItems) {
      const full = libraryById.get(i.id);
      meta.set(i.id, {
        title: i.title,
        author: i.author,
        sizeBytes: i.sizeBytes,
        width: full?.width ?? null,
        height: full?.height ?? null,
      });
    }
    for (const i of libraryStore.items) {
      if (!meta.has(i.id)) {
        meta.set(i.id, { title: i.title, author: i.author, sizeBytes: i.sizeBytes, width: i.width, height: i.height });
      }
    }
    return meta;
  });

  async function load(): Promise<void> {
    loadState = "loading";
    // libraryStore が未取得（idle）なら、unassigned（$derived、libraryStore.items
    // 参照）が一瞬空のまま描画されないよう取得完了を待ってから進む。既に
    // loading/loaded ならここでは待たない（in-flight を待つ、または既存データを
    // そのまま使う）が、itemMeta が $derived になった今はそのケースでも
    // libraryStore.items が後から更新され次第 itemMeta が自動的に追従する。
    if (libraryStore.loadState === "idle") await libraryStore.load();
    const lib = await devicesStore.getLibrary(device.id);
    if (!lib) {
      loadState = "fail";
      return;
    }
    version = lib.version;
    const sorted = lib.items.slice().sort((a, b) => a.position - b.position);
    assignedOrder = sorted.map((i) => i.id);
    deviceItems = sorted;
    loadState = "loaded";
  }

  onMount(() => {
    dlg?.showModal();
    void load();
  });

  function itemLabel(id: string): ItemMeta {
    return itemMeta.get(id) ?? { title: id, author: null, sizeBytes: 0, width: null, height: null };
  }

  function isMismatch(meta: ItemMeta): boolean {
    return isResolutionMismatch({ width: device.width, height: device.height }, { width: meta.width, height: meta.height });
  }

  function addItem(id: string): void {
    if (assignedOrder.includes(id)) return;
    assignedOrder = [id, ...assignedOrder];
  }
  function removeItem(id: string): void {
    assignedOrder = assignedOrder.filter((x) => x !== id);
  }
  function moveUp(index: number): void {
    if (index <= 0) return;
    const next = assignedOrder.slice();
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    assignedOrder = next;
  }
  function moveDown(index: number): void {
    if (index >= assignedOrder.length - 1) return;
    const next = assignedOrder.slice();
    [next[index + 1], next[index]] = [next[index], next[index + 1]];
    assignedOrder = next;
  }
  function selectAll(): void {
    assignedOrder = [...unassigned, ...assignedOrder];
  }
  function deselectAll(): void {
    assignedOrder = [];
  }

  function reload(): void {
    conflict = false;
    void load();
  }

  async function onSave(): Promise<void> {
    if (version === null) return;
    saving = true;
    conflict = false;
    saveFailed = false;
    const result = await devicesStore.replaceLibrary(device.id, version, assignedOrder);
    saving = false;
    if (result.ok) {
      onclose();
      return;
    }
    if (result.conflict) conflict = true;
    else saveFailed = true;
  }

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) onclose();
  }
</script>

<dialog
  class="simple-dialog wide"
  bind:this={dlg}
  aria-labelledby="dle-title"
  onclick={onDialogClick}
  onclose={onclose}
>
  <div class="dlg-head">
    <span class="dlg-title" id="dle-title">{t("device_library_title")(device.name)}</span>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={onclose}>×</button>
  </div>
  <div class="dlg-body">
    {#if loadState === "loading"}
      <p class="note">{t("library_loading")}</p>
    {:else if loadState === "fail"}
      <p class="error-text">{t("library_load_failed")}</p>
    {:else if conflict}
      <div class="conflict-box">
        <p class="error-text">{t("device_library_conflict")}</p>
        <button type="button" class="secondary" onclick={reload}>{t("device_library_reload")}</button>
      </div>
    {:else}
      {#if assignedOrder.length === 0 && unassigned.length === 0}
        <p class="note">{t("device_library_empty")}</p>
      {:else}
        <div class="bulk-actions">
          <button type="button" class="text-btn" disabled={unassigned.length === 0} onclick={selectAll}>{t("device_library_select_all")}</button>
          <button type="button" class="text-btn" disabled={assignedOrder.length === 0} onclick={deselectAll}>{t("device_library_deselect_all")}</button>
        </div>
        <ul class="dle-list">
          {#each assignedOrder as id, index (id)}
            {@const meta = itemLabel(id)}
            <li class="dle-row">
              <label class="dle-check">
                <input type="checkbox" checked onchange={() => removeItem(id)} />
                <span class="dle-title">{meta.title}</span>
                {#if isMismatch(meta)}<span class="mismatch-badge">{t("device_library_resolution_mismatch")}</span>{/if}
              </label>
              <div class="dle-order-btns">
                <button type="button" disabled={index === 0} onclick={() => moveUp(index)} aria-label={t("device_library_move_up")}>▲</button>
                <button type="button" disabled={index === assignedOrder.length - 1} onclick={() => moveDown(index)} aria-label={t("device_library_move_down")}>▼</button>
              </div>
            </li>
          {/each}
          {#each unassigned as id (id)}
            {@const meta = itemLabel(id)}
            <li class="dle-row dle-row-unassigned">
              <label class="dle-check">
                <input type="checkbox" onchange={() => addItem(id)} />
                <span class="dle-title dim">{meta.title}</span>
                {#if isMismatch(meta)}<span class="mismatch-badge">{t("device_library_resolution_mismatch")}</span>{/if}
              </label>
            </li>
          {/each}
        </ul>
      {/if}
      {#if saveFailed}<p class="error-text">{t("device_library_save_failed")}</p>{/if}
    {/if}
  </div>
  {#if loadState === "loaded" && !conflict}
    <div class="dlg-actions">
      <button type="button" class="dlg-cancel" onclick={onclose}>{t("cancel")}</button>
      <button type="button" class="dlg-submit" disabled={saving} onclick={() => void onSave()}>{t("device_library_save")}</button>
    </div>
  {/if}
</dialog>

<style>
  .note { color: var(--muted); font-size: 14px; margin: 0; }
  .conflict-box { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
  .bulk-actions { display: flex; gap: 16px; margin-bottom: 12px; }
  .text-btn {
    border: 0; background: none; font: inherit; font-size: 14px; color: var(--muted2);
    text-decoration: underline; cursor: pointer; padding: 0;
  }
  .text-btn:disabled { opacity: .5; cursor: default; }
  button.secondary {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  button.secondary:hover { background: var(--panel); }
  ul.dle-list { list-style: none; margin: 0; padding: 0; }
  li.dle-row {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 8px 0; border-top: 1px solid var(--line);
  }
  li.dle-row:last-child { border-bottom: 1px solid var(--line); }
  .dle-check { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; cursor: pointer; }
  .dle-check input { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--ink); cursor: pointer; }
  .dle-title { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dle-title.dim { color: var(--faint); }
  .mismatch-badge {
    flex: none; font-size: 11px; color: var(--muted2); border: 1px solid var(--line);
    border-radius: 3px; padding: 1px 6px; white-space: nowrap;
  }
  .dle-order-btns { display: flex; gap: 4px; flex: none; }
  .dle-order-btns button {
    width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 4px;
    background: var(--card); color: var(--text); cursor: pointer; font-size: 14px;
  }
  .dle-order-btns button:disabled { color: var(--disabled); cursor: default; }
</style>
